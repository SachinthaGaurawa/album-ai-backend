// api/ping.js – Simple health check endpoint.
export default function handler(req, res) {
  res.status(200).json({ status: "ok", message: "AI chatbot backend is running." });
}
