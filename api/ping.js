// CommonJS, zero deps. Confirms routing and CORS.
module.exports = async (req, res) => {
  res.statusCode = 200;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: true,
    route: "/api/ping",
    method: req.method,
    now: new Date().toISOString()
  }));
};
