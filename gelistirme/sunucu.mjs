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
import { saglayicilar } from "../worker/src/ikiz.js";

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

// wrangler.toml'daki [vars]: yerel sunucu yayınla aynı ayarlarla koşsun (paralı model listesi, sınırlar). Yoksa yerel
// sınav paralı yuvayı hiç görmüyordu, her soru bir saniyede 503 dönüyordu (2026-10-19). .dev.vars bunların üstüne yazar.
function tomlDegiskenleri() {
  const yol = join(KOK, "worker", "wrangler.toml");
  if (!existsSync(yol)) return {};
  const bolum = readFileSync(yol, "utf8").split(/^\[vars\]\s*$/m)[1]?.split(/^\[/m)[0] || "";
  const env = {};
  for (const satir of bolum.split(/\r?\n/)) {
    const m = satir.match(/^\s*([A-Z_]+)\s*=\s*"(.*)"\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = {
  ...tomlDegiskenleri(),
  ...devVars(),
  BILGI_METNI: readFileSync(join(KOK, "..", "bilgi", "bilgi.md"), "utf8"),
  TASLAGA_IZIN: "1",
  GELISTIRME: "1", // hata ayrıntısı ve tür/sağlayıcı yalnız yerelde döner
  IZINLI_KOKENLER: `http://localhost:${PORT}`,
  TURNSTILE_ZORUNLU: "", // yerelde bot doğrulaması yok (site anahtarı yalnız bora-eem.github.io için)
};
if (process.env.KAYIT !== "1") delete env.GITHUB_TOKEN; // yerelde kayıt varsayılan kapalı
// Yerelde paralı yuva varsayılan kapalı: yerel sayaç bellekte, her yeniden başlatmada günlük tavan sıfırlanır; gezinme
// ücretsiz pay bitince paralı anahtarı harcamasın. Sınav ya da ölçüm için UCRETLI=1 (inceleme 2026-10-19).
if (process.env.UCRETLI !== "1" && env.GEMINI_UCRETLI_API_KEY) {
  delete env.GEMINI_UCRETLI_API_KEY;
  console.log("paralı yuva kapalı (UCRETLI=1 ile açılır)");
}

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
    // Yalnız yerelde ve yalnız sınav anahtarıyla: sınav belirli bir sağlayıcıyı zorlayabilir (anahtarsız biri paralı
    // yuvayı zorlayıp bütçe yakamasın; saldırı denemesi 2026-10-19).
    const anahtarli = env.SINAV_ANAHTARI && req.headers["x-sinav-anahtari"] === env.SINAV_ANAHTARI;
    const zorla = anahtarli && req.headers["x-yalniz-saglayici"];
    if (req.headers["x-yalniz-saglayici"] && !anahtarli) {
      console.error("X-Yalniz-Saglayici anahtarsız geldi, yok sayıldı: sınav bütün sırayı koşar, sonucu o yuvaya yazma");
    }
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
  const s = saglayicilar(env).map((y) => y.ad);
  console.log(`dijital-ikiz yerel: http://localhost:${PORT}  (sağlayıcılar: ${s.join(", ") || "YOK"})`);
});
