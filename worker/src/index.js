// Ara sunucu: anahtarları ve bilgi dosyasını tarayıcıdan uzak tutar. Tek uç nokta: POST /api/sohbet.
// Hatalar ziyaretçiye tek cümle döner; ayrıntı yalnız sunucu günlüğüne (Cloudflare: Workers → Logs) yazılır.
import { cevapla, mesajlariDogrula, soruyuKaydet } from "./ikiz.js";

// Aynı adresten dakikada en çok bu kadar soru. Yayında Cloudflare'in hız sınırı bağlaması (HIZ_SINIRI, wrangler.toml)
// bütün sunucu örnekleri için ortak sayar; yoksa (yerel) bellekteki sayaç kullanılır.
const DAKIKALIK_SORU = 8;
const sayac = new Map();

async function hizSiniriAsildi(ip, env) {
  if (env.HIZ_SINIRI?.limit) {
    const { success } = await env.HIZ_SINIRI.limit({ key: ip });
    return !success;
  }
  const simdi = Date.now();
  const kayit = (sayac.get(ip) || []).filter((t) => simdi - t < 60_000);
  kayit.push(simdi);
  sayac.set(ip, kayit);
  if (sayac.size > 5000) sayac.clear();
  return kayit.length > DAKIKALIK_SORU;
}

function corsBasliklari(istek, env) {
  const koken = istek.headers.get("Origin") || "";
  const izinli = (env.IZINLI_KOKENLER || "").split(",").map((k) => k.trim()).filter(Boolean);
  const basliklar = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (izinli.includes(koken)) basliklar["Access-Control-Allow-Origin"] = koken;
  return basliklar;
}

function json(veri, durum, basliklar) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: { "Content-Type": "application/json; charset=utf-8", ...basliklar },
  });
}

const GENEL_HATA = "Şu an cevap veremiyorum, birazdan tekrar deneyin.";

export async function istegiIsle(istek, env, ctx) {
  const url = new URL(istek.url);
  const cors = corsBasliklari(istek, env);
  const gelistirme = env.GELISTIRME === "1";

  if (istek.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname !== "/api/sohbet") return json({ hata: "bulunamadı" }, 404, cors);
  if (istek.method !== "POST") return json({ hata: "yalnız POST" }, 405, cors);

  const ip = istek.headers.get("CF-Connecting-IP") || "yerel";
  if (await hizSiniriAsildi(ip, env)) return json({ hata: "Çok hızlı soruyorsunuz, bir dakika sonra tekrar deneyin." }, 429, cors);

  let govde;
  try {
    govde = await istek.json();
  } catch {
    return json({ hata: "geçersiz JSON" }, 400, cors);
  }
  const { mesajlar, hata } = mesajlariDogrula(govde);
  if (hata) return json({ hata }, 400, cors);

  let sonuc;
  try {
    sonuc = await cevapla(mesajlar, env, govde?.dil === "en" ? "en" : "tr");
  } catch (e) {
    console.error(`cevaplanamadı: ${e.message}`);
    return json(gelistirme ? { hata: GENEL_HATA, ayrinti: e.message } : { hata: GENEL_HATA }, 503, cors);
  }
  if (sonuc.durum !== 200) {
    console.error(`cevap yok: ${sonuc.hata} ${JSON.stringify(sonuc.denemeler)}`);
    return json(gelistirme ? { hata: sonuc.hata, denemeler: sonuc.denemeler } : { hata: sonuc.hata }, sonuc.durum, cors);
  }

  if (sonuc.iletildi) {
    const soru = mesajlar[mesajlar.length - 1].content;
    const kayit = soruyuKaydet(soru, sonuc.cevap, env)
      .then((k) => {
        if (!k.kaydedildi && k.neden !== "bugün zaten kaydedildi") console.error(`soru kaydedilemedi: ${k.neden}`);
        return k;
      })
      .catch((e) => {
        console.error(`soru kaydedilemedi: ${e.message}`);
        return { kaydedildi: false };
      });
    if (ctx?.waitUntil) ctx.waitUntil(kayit);
    else await kayit;
  }
  const yanit = { cevap: sonuc.cevap, iletildi: sonuc.iletildi };
  if (gelistirme) Object.assign(yanit, { tur: sonuc.tur, saglayici: sonuc.saglayici });
  return json(yanit, 200, cors);
}

export default { fetch: istegiIsle };
