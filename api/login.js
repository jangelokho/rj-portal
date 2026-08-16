// POST /api/login  { password }  -> 200 {ok:true} | 401
// The gate is stateless: on success the browser stores the password and sends it
// as the `x-portal-password` header on every subsequent /api/* call.

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const password = req.body && req.body.password;
  if (password && password === process.env.PORTAL_PASSWORD) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ error: "Wrong password" });
}
