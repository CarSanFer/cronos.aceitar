// api/serve-fatura.js — CRONOS · Aceitar
// Serve o PDF de uma fatura directamente da NAS para o browser

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const { path: ficheirNas } = req.query;
  if (!ficheirNas) return res.status(400).json({ error: 'Falta parâmetro path' });

  const NAS_URL  = process.env.NAS_URL;
  const NAS_USER = process.env.NAS_USER;
  const NAS_PASS = process.env.NAS_PASS;

  try {
    // 1. Autenticar na NAS
    const authR = await fetch(
      `${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login` +
      `&account=${encodeURIComponent(NAS_USER)}&passwd=${encodeURIComponent(NAS_PASS)}` +
      `&session=filestation&format=sid`
    );
    const auth = await authR.json();
    if (!auth.success) return res.status(401).json({ error: 'Falha na autenticação NAS' });
    const sid = auth.data.sid;

    // 2. Download do PDF
    const dlR = await fetch(
      `${NAS_URL}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download` +
      `&path=${encodeURIComponent(ficheirNas)}&mode=download&_sid=${sid}`
    );

    // Logout (não bloquear a resposta)
    fetch(`${NAS_URL}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=logout&session=filestation&_sid=${sid}`).catch(()=>{});

    if (!dlR.ok) return res.status(404).json({ error: 'Ficheiro não encontrado na NAS' });

    // 3. Enviar PDF para o browser
    const buffer = Buffer.from(await dlR.arrayBuffer());
    const nome = ficheirNas.split('/').pop() || 'fatura.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nome}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, max-age=300'); // cache 5 min
    return res.status(200).send(buffer);

  } catch(e) {
    return res.status(500).json({ error: 'Erro interno', detalhe: e.message });
  }
}
