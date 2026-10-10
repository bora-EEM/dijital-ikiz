// Yerel geliştirme sunucusu: docs/ altındaki sayfayı sunar, /api/sohbet'i ara sunucu koduna verir.
// Anahtarlar worker/.dev.vars'tan (git dışı), bilgi dosyası ../bilgi/bilgi.md'den okunur; hiçbiri ekrana yazılmaz.
// Yalnız bu bilgisayardan erişilir (127.0.0.1).
//   node gelistirme/sunucu.mjs            (http://localhost:8787)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { istegiIsle } from "../worker/src/index.js";

const KOK = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8787);

function devVars() {
  const yol = join(KOK, "worker", ".dev.vars");
  if (!existsSync(yol)) return {};
  const env = {};
  for (const satir of readFileSync(yol, "utf8").split(/\r?\n/)) {
    const m = satir.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = {
  ...devVars(),
  BILGI_METNI: readFileSync(join(KOK, "..", "bilgi", "bilgi.md"), "utf8"),
  TASLAGA_IZIN: "1",
  GELISTIRME: "1", // hata ayrıntısı ve tür/sağlayıcı yalnız yerelde döner
  IZINLI_KOKENLER: `http://localhost:${PORT}`,
};
if (process.env.KAYIT !== "1") delete env.GITHUB_TOKEN; // yerelde kayıt varsayılan kapalı

// Yerelde Workers AI bağlaması yok; hesap kimliği ve erişim anahtarı ortamdan verilirse aynı modele REST ile gidilir
// (sınavın üçüncü yuvayı da koşabilmesi için). Değerler yazdırılmaz.
if (process.env.CF_HESAP && process.env.CF_AI_TOKEN) {
  env.AI = {
    run: async (model, govde) => {
      const yanit = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_HESAP}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CF_AI_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(govde),
      });
      if (!yanit.ok) throw new Error(`HTTP ${yanit.status} ${(await yanit.text()).slice(0, 200)}`);
      return (await yanit.json()).result;
    },
  };
}

const TURLER = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const parcalar = [];
    for await (const p of req) parcalar.push(p);
    const istek = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(parcalar),
    });
    // Yalnız yerelde: sınav belirli bir sağlayıcıyı zorlayabilir (yayındaki ara sunucuda bu başlık yok sayılır).
    const zorla = req.headers["x-yalniz-saglayici"];
    const yanit = await istegiIsle(istek, zorla ? { ...env, YALNIZ_SAGLAYICI: zorla } : env, null);
    res.writeHead(yanit.status, Object.fromEntries(yanit.headers));
    res.end(Buffer.from(await yanit.arrayBuffer()));
    return;
  }
  const yol = join(KOK, "docs", url.pathname === "/" ? "index.html" : url.pathname);
  let icerik;
  try {
    icerik = await readFile(yol);
  } catch {
    res.writeHead(404).end("bulunamadı");
    return;
  }
  res.writeHead(200, { "Content-Type": TURLER[extname(yol)] || "application/octet-stream" });
  res.end(icerik);
}).listen(PORT, "127.0.0.1", () => {
  const s = ["GROQ_API_KEY", "GEMINI_API_KEY"].filter((k) => env[k]);
  console.log(`dijital-ikiz yerel: http://localhost:${PORT}  (sağlayıcılar: ${s.join(", ") || "YOK"})`);
});
