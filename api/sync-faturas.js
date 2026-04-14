// api/sync-faturas.js — CRONOS · Aceitar
// Sincroniza faturas da NAS Synology para o Supabase

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { mes } = req.body; // ex: "202601"
  if (!mes || !/^\d{6}$/.test(mes))
    return res.status(400).json({ error: 'Formato de mês inválido. Use "YYYY MM"' });

  const NAS_URL   = process.env.NAS_URL;           // http://aceitar.synology.me:5000
  const NAS_USER  = process.env.NAS_USER;
  const NAS_PASS  = process.env.NAS_PASS;
  const SB_URL    = process.env.SUPABASE_URL;
  const SB_KEY    = process.env.SUPABASE_SERVICE_KEY; // service_role key para bypass RLS
  const AI_KEY    = process.env.ANTHROPIC_API_KEY;
  const PASTA_BASE = '/100 Departamentos/200 FIN/900 FTs';
  const PASTA_MES  = `${PASTA_BASE}/${mes}`;

  // ── helpers ──────────────────────────────────────────────────────────────
  const sbFetch = (path, opts={}) => fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
                'Content-Type': 'application/json', 'Prefer': 'return=representation', ...(opts.headers||{}) }
  });

  try {
    // ── 1. Autenticar na NAS ─────────────────────────────────────────────
    const authR = await fetch(
      `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login` +
      `&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}` +
      `&session=filestation&format=sid`
    );
    const auth = await authR.json();
    if (!auth.success) return res.status(401).json({ error: 'Falha na autenticação da NAS', detalhe: auth.error });
    const sid = auth.data.sid;

    // ── 2. Listar ficheiros na pasta do mês ──────────────────────────────
    const listParams = new URLSearchParams({
      api: 'SYNO.FileStation.List',
      version: '2',
      method: 'list',
      folder_path: PASTA_MES,
      _sid: sid
    });
    const listR = await fetch(
      `${NAS_URL}/webapi/entry.cgi`,
      { method: 'POST', body: listParams }
    );
    const list = await listR.json();
    if (!list.success) {
      await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=logout&session=filestation&_sid=${sid}`);
      return res.status(404).json({ error: `Pasta não encontrada: ${PASTA_MES}`, detalhe: JSON.stringify(list), raw: JSON.stringify(list.error) });
    }

    const ficheiros = (list.data?.files || [])
      .filter(f => !f.isdir && f.name.toLowerCase().endsWith('.pdf'));

    if (!ficheiros.length) {
      await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=logout&session=filestation&_sid=${sid}`);
      return res.json({ ok: true, novos: 0, existentes: 0, erros: [], mensagem: 'Nenhum PDF encontrado na pasta.' });
    }

    // ── 3. Verificar o que já existe no Supabase ──────────────────────────
    const existR = await sbFetch(`faturas?select=ficheiro_nome&ficheiro_nome=in.(${ficheiros.map(f=>`"${f.name}"`).join(',')})`);
    const existJson = await existR.json();
    const existArr = Array.isArray(existJson) ? existJson : [];
    const existentes = new Set(existArr.map(r => r.ficheiro_nome));

    const novos = ficheiros.filter(f => !existentes.has(f.name));

    // ── 4. Processar ficheiros novos ──────────────────────────────────────
    const resultados = [];
    const erros = [];

    for (const fich of novos) {
      try {
        // Download do PDF
        const dlR = await fetch(
          `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download` +
          `&path=${encodeURIComponent(PASTA_MES + '/' + fich.name)}&mode=download&_sid=${sid}`
        );
        if (!dlR.ok) throw new Error(`Download falhou: ${dlR.status}`);
        const pdfBuf = await dlR.arrayBuffer();
        const pdfB64 = Buffer.from(pdfBuf).toString('base64');

        // Extrair dados com Claude
        const aiR = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
                { type: 'text', text: `Extrai os dados desta fatura e devolve APENAS JSON válido, sem markdown nem texto extra:
{
  "numero": "FAC AC26/XX",
  "data_fatura": "YYYY-MM-DD",
  "vencimento": "YYYY-MM-DD",
  "cliente": "nome do cliente",
  "nif_cliente": "NIF",
  "valor": 1234.56,
  "descricao": "descrição do serviço"
}
O valor deve ser o TOTAL LÍQUIDO (sem IVA). Se não encontrares algum campo, coloca null.` }
              ]
            }]
          })
        });
        const ai = await aiR.json();
        const aiText = ai.content?.[0]?.text || '';
        const cleaned = aiText.replace(/```json|```/g,'').trim();
        const dados = JSON.parse(cleaned);

        // Determinar sigla e grupo pelo nome do ficheiro
        const nome = fich.name.replace('.pdf','');
        let sigla_obra = null, grupo = 'Obras';
        const partes = nome.split('_');
        if (partes[0] === 'AI') {
          // AI_YYYY_MM_SIGLA → AInspec
          grupo = 'AInspec';
          sigla_obra = partes.slice(3).join('_').replace('_2','') || null;
        } else if (partes[0] === 'P') {
          // P_YYYY_MM_SIGLA → Projeto
          grupo = 'Projetos';
          sigla_obra = partes.slice(3).join('_').replace('_2','') || null;
        } else if (partes[0] === 'C') {
          // C_YYYY_MM_SIGLA → Concurso
          grupo = 'Concursos';
          sigla_obra = partes.slice(3).join('_').replace('_2','') || null;
        } else if (partes[0] === 'NC') {
          grupo = 'Extras';
          sigla_obra = partes.slice(3).join('_') || null;
          dados.valor = dados.valor ? -Math.abs(dados.valor) : null;
        } else {
          // YYYY_MM_SIGLA ou YYYY_MM_SIGLA_2
          const siglaRaw = partes.slice(2).join('_');
          if (siglaRaw.endsWith('_2')) {
            grupo = 'Extras';
            sigla_obra = siglaRaw.replace('_2','');
          } else {
            sigla_obra = siglaRaw || null;
          }
        }

        // Guardar no Supabase (sem b64 — PDFs ficam na NAS)
        const sbR = await sbFetch('faturas', {
          method: 'POST',
          body: JSON.stringify({
            numero: dados.numero, data_fatura: dados.data_fatura,
            vencimento: dados.vencimento, cliente: dados.cliente,
            nif_cliente: dados.nif_cliente, valor: dados.valor,
            descricao: dados.descricao, sigla_obra, grupo,
            ficheiro_nome: fich.name,
            ficheiro_nas: `${PASTA_MES}/${fich.name}`
          })
        });
        const sbJson = await sbR.json();
        if(!sbR.ok) throw new Error(`Supabase insert falhou: ${JSON.stringify(sbJson)}`);

        resultados.push({ ficheiro: fich.name, numero: dados.numero, valor: dados.valor, grupo, sigla_obra });
      } catch(e) {
        erros.push({ ficheiro: fich.name, erro: e.message });
      }
    }

    // Logout NAS
    await fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=logout&session=filestation&_sid=${sid}`);

    return res.json({
      ok: true, novos: resultados.length, existentes: existentes.size || 0,
      erros, resultados,
      mensagem: `${resultados.length} fatura(s) nova(s) sincronizada(s). ${existentes.size} já existia(m).`
    });

  } catch(e) {
    return res.status(500).json({ error: 'Erro interno', detalhe: e.message });
  }
}
