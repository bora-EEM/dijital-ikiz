// Ara sunucu: anahtarları ve bilgi dosyasını tarayıcıdan uzak tutar. Tek uç nokta: POST /api/sohbet.
// Hatalar ziyaretçiye tek cümle döner; ayrıntı yalnız sunucu günlüğüne (Cloudflare: Workers → Logs) yazılır.
//
// Kapıdaki katmanlar, sırayla (her biri bir kötüye kullanım yolunu kapatır):
//   1. Köken, içerik türü, gövde boyutu: başka bir site kendi ziyaretçilerinin tarayıcısını bize soru sordurmak için
//      kullanamaz (JSON zorunluluğu tarayıcıyı ön kontrole zorlar, izinsiz köken 403).
//   2. Dakikalık hız sınırı, IPv6'da /64 önekiyle (adres değiştirerek aşılamaz).
//   3. Bot doğrulaması (Turnstile) → iki saatlik imzalı oturum; oturum başına soru tavanı.
//   4. İmzalı geçmiş: ikizin önceki cevapları sunucunun imzasıyla döner, sahte "önceki cevap" reddedilir.
//   5. Kalıcı günlük sayaç: IP başına, oturum başına, toplam; paralı model için günlük harcama tavanı.
// Sınav ve sağlık kontrolü X-Sinav-Anahtari ile 3 ve 4'ü atlar (anahtar yalnız Cloudflare sırrında ve Bora'da).
import { bilgiyiAl, cevapla, hazirCevap, mesajlariDogrula, soruyuKaydet, isverenCevabiniKaydet, saglayicilar } from "./ikiz.js";
import { sayacaSor, Sayac } from "./sayac.js";
import { ipAnahtari, cevapImzasi, cevapImzasiDogru, oturumOlustur, oturumDogrula, turnstileDogrula, esit } from "./guvenlik.js";

export { Sayac };

const DAKIKALIK_SORU = 8;
const GOVDE_SINIRI = 16 * 1024;
const sayac = new Map();
let bellekUyarisi = false;

async function hizSiniriAsildi(anahtar, env) {
  if (env.HIZ_SINIRI?.limit) {
    const { success } = await env.HIZ_SINIRI.limit({ key: anahtar });
    return !success;
  }
  if (!bellekUyarisi && env.GELISTIRME !== "1") {
    console.error("HIZ_SINIRI bağlaması yok: dakikalık sınır bellekte, örnek başına");
    bellekUyarisi = true;
  }
  const simdi = Date.now();
  const kayit = (sayac.get(anahtar) || []).filter((t) => simdi - t < 60_000);
  kayit.push(simdi);
  sayac.set(anahtar, kayit);
  if (sayac.size > 5000) sayac.clear();
  return kayit.length > DAKIKALIK_SORU;
}

function izinliKokenler(env) {
  return (env.IZINLI_KOKENLER || "").split(",").map((k) => k.trim()).filter(Boolean);
}

function corsBasliklari(istek, env) {
  const koken = istek.headers.get("Origin") || "";
  const basliklar = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Davet",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (izinliKokenler(env).includes(koken)) basliklar["Access-Control-Allow-Origin"] = koken;
  return basliklar;
}

function json(veri, durum, basliklar) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...basliklar },
  });
}

const GENEL_HATA = "Şu an cevap veremiyorum, birazdan tekrar deneyin.";
const SINIR_METNI = {
  hiz: "Çok hızlı soruyorsunuz, bir dakika sonra tekrar deneyin.",
  gunluk: "Bugünlük soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
  oturum: "Bu oturumdaki soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
  genel: "İkiz bugün çok soru aldı. Devamı için bana e-postayla yazabilirsiniz.",
};

export async function istegiIsle(istek, env, ctx) {
  const url = new URL(istek.url);
  const cors = corsBasliklari(istek, env);
  const gelistirme = env.GELISTIRME === "1";

  if (istek.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // Dış izleme için hafif uç: yapay zekâ çağırmaz, yalnız bilgi dosyasına ulaşılıyor mu ve sayaç çalışıyor mu.
  if (url.pathname === "/saglik" && istek.method === "GET") {
    if (await hizSiniriAsildi(`saglik-${ipAnahtari(istek.headers.get("CF-Connecting-IP") || "yerel")}`, env)) {
      return json({ hata: SINIR_METNI.hiz, kod: "hiz" }, 429, cors);
    }
    try {
      if (!env.ILETISIM_EPOSTA) throw new Error("ILETISIM_EPOSTA ayarı yok");
      await bilgiyiAl(env, { taze: true }); // GitHub'a ve anahtara gerçekten ulaşılıyor mu (yedek sayılmaz)
      await sayacaSor(env, { islem: "butce" });
      return json({ tamam: true }, 200, cors);
    } catch (e) {
      console.error(`sağlık ucu: ${e.message}`);
      return json({ tamam: false }, 503, cors);
    }
  }
  // Sayfanın göstereceği iletişim adresi: açık depoda durmasın diye sunucunun gizli ayarında (ILETISIM_EPOSTA,
  // Bora'nın kararı 2026-10-19); sayfa adresi buradan alır. Ayar yoksa 503: sayfa bağlantıyı gizli tutar.
  if (url.pathname === "/api/iletisim" && istek.method === "GET") {
    if (await hizSiniriAsildi(`iletisim-${ipAnahtari(istek.headers.get("CF-Connecting-IP") || "yerel")}`, env)) {
      return json({ hata: SINIR_METNI.hiz, kod: "hiz" }, 429, cors);
    }
    if (!env.ILETISIM_EPOSTA) {
      console.error("ILETISIM_EPOSTA ayarı yok");
      return json({ eposta: null }, 503, cors);
    }
    // Sayfa açılışı istatistiğe yazılır (isimsiz toplam); sayaç düşerse adres yine verilir.
    const davet = Boolean(env.DAVET_ANAHTARI) && esit(istek.headers.get("X-Davet") || "", env.DAVET_ANAHTARI);
    const ziyaret = sayacaSor(env, { islem: "ziyaret", ip: ipAnahtari(istek.headers.get("CF-Connecting-IP") || "yerel"), davet })
      .catch((e) => console.error(`ziyaret sayılamadı: ${e.message}`));
    if (ctx?.waitUntil) ctx.waitUntil(ziyaret);
    else await ziyaret;
    return json({ eposta: env.ILETISIM_EPOSTA }, 200, cors);
  }
  // İstatistik (kaç kişi girdi, kaç soru sordu): yalnız sınav anahtarıyla; anahtarsız istek ucun varlığını da görmez.
  if (url.pathname === "/api/istatistik" && istek.method === "GET") {
    const anahtar = (istek.headers.get("Authorization") || "").replace(/^Bearer /, "");
    if (!env.SINAV_ANAHTARI || !esit(anahtar, env.SINAV_ANAHTARI)) return json({ hata: "bulunamadı" }, 404, cors);
    try {
      return json(await sayacaSor(env, { islem: "istatistik" }), 200, cors);
    } catch (e) {
      console.error(`istatistik okunamadı: ${e.message}`);
      return json({ hata: GENEL_HATA }, 503, cors);
    }
  }
  if (url.pathname !== "/api/sohbet") return json({ hata: "bulunamadı" }, 404, cors);
  if (istek.method !== "POST") return json({ hata: "yalnız POST" }, 405, cors);

  // 1. Köken, içerik türü, boyut.
  const koken = istek.headers.get("Origin");
  if (koken && !izinliKokenler(env).includes(koken)) return json({ hata: "izinsiz köken" }, 403, cors);
  if (!(istek.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return json({ hata: "yalnız JSON" }, 415, cors);
  }
  if (Number(istek.headers.get("Content-Length") || 0) > GOVDE_SINIRI) return json({ hata: "istek çok büyük" }, 413, cors);
  const ham = await istek.text();
  if (ham.length > GOVDE_SINIRI) return json({ hata: "istek çok büyük" }, 413, cors);
  let govde;
  try {
    govde = JSON.parse(ham);
  } catch {
    return json({ hata: "geçersiz JSON" }, 400, cors);
  }

  const sinav = Boolean(env.SINAV_ANAHTARI) && esit(istek.headers.get("X-Sinav-Anahtari") || "", env.SINAV_ANAHTARI);

  // 2. Dakikalık hız sınırı.
  const ip = istek.headers.get("CF-Connecting-IP") || "";
  const ipKey = ipAnahtari(ip || "yerel");
  if (await hizSiniriAsildi(ipKey, env)) return json({ hata: SINIR_METNI.hiz, kod: "hiz" }, 429, cors);

  // 3. Bot doğrulaması ve oturum. Turnstile sırrı yoksa (yerel) oturum IP'ye bağlanır.
  let oturum = null;
  let yeniJeton = null;
  if (!sinav) {
    if (env.TURNSTILE_SECRET && env.IMZA_SIRRI) {
      oturum = await oturumDogrula(env.IMZA_SIRRI, govde?.oturum);
      if (!oturum) {
        if (!(await turnstileDogrula(env.TURNSTILE_SECRET, govde?.dogrulama, ip, env.TURNSTILE_ALAN || "bora-eem.github.io"))) {
          return json({ hata: "Doğrulama gerekiyor.", kod: "dogrulama" }, 401, cors);
        }
        ({ kimlik: oturum, jeton: yeniJeton } = await oturumOlustur(env.IMZA_SIRRI));
      }
    } else {
      if (env.TURNSTILE_ZORUNLU === "1") {
        console.error("TURNSTILE_SECRET ya da IMZA_SIRRI yok ama zorunlu: istek reddedildi");
        return json({ hata: GENEL_HATA }, 503, cors);
      }
      oturum = `ip-${ipKey}`;
    }
  }

  const { mesajlar, hata } = mesajlariDogrula(govde);
  if (hata) return json({ hata }, 400, cors);

  // 4. İmzalı geçmiş: her "asistan" mesajı bu oturumda sunucunun verdiği imzayı taşımalı.
  if (!sinav && env.IMZA_SIRRI) {
    const gelen = Array.isArray(govde.mesajlar) ? govde.mesajlar.slice(-8) : [];
    for (const m of gelen) {
      if (m?.rol !== "assistant") continue;
      if (!(await cevapImzasiDogru(env.IMZA_SIRRI, oturum, m.icerik, m.imza))) {
        // Yeni oturum açıldıysa jeton yine döner: sayfa geçmişsiz tekrar sorarken doğrulamayı baştan istemesin.
        return json({ hata: "Sohbet geçmişi doğrulanamadı.", kod: "gecmis", ...(yeniJeton ? { oturum: yeniJeton } : {}) }, 409, cors);
      }
    }
  }

  // 5. Günlük sayaç. Sayaca ulaşılamazsa kapalı kalınır (sınırsız açık kalmaktansa).
  let izin;
  try {
    // Paralı yuva sıradaysa bir sorunun en kötü maliyeti baştan ayrılır: 14.000 girdi token (istem ~9.500, Gemini
    // sayımı 2026-10-19; en uzun geçmiş 8 mesaj ~2.800; bilgi dosyasının büyümesine pay) ve 2.000 çıktı token
    // (paralı yuvanın max_tokens sınırı, ikiz.js). Fazlası cevap gelince geri yazılır.
    // Bir soruda paralı yuvaların hepsi sırayla çağrılabilir (ilki boş dönerse ikincisi): ayırma toplamdır.
    const rezerve = saglayicilar(env).filter((s) => s.ucretli)
      .reduce((t, s) => t + (14_000 * s.ucretli.girdi + 2_000 * s.ucretli.cikti) / 1e6, 0);
    // Davet kodu sunucunun gizli ayarında (DAVET_ANAHTARI); açık depoda değil, yalnız özgeçmişteki bağlantıda.
    const davet = Boolean(env.DAVET_ANAHTARI) && esit(String(govde?.davet ?? ""), env.DAVET_ANAHTARI);
    izin = await sayacaSor(env, { islem: "izin", ip: ipKey, oturum, sinav, rezerve, davet });
  } catch (e) {
    console.error(`sayaç ulaşılamadı: ${e.message}`);
    return json({ hata: GENEL_HATA }, 503, cors);
  }
  if (!izin.tamam) return json({ hata: SINIR_METNI[izin.kod] || GENEL_HATA, kod: izin.kod }, 429, cors);

  // Paralı model yalnız günlük bütçe dolmadıysa (izin cevabı bütçeyi de taşır). Sınav anahtarıyla gelen istek tek bir
  // yuvayı zorlayabilir: canlıda her yuva ayrı sınanır (paralı yuva sıraya ancak sınavı geçince girer).
  let calismaEnv = izin.butceDoldu !== false ? { ...env, UCRETLI_KAPALI: "1" } : env;
  const zorla = sinav && istek.headers.get("X-Yalniz-Saglayici");
  // Zorlanan yuva da bütçe tavanına uyar: bütçe doluyken zorlanan paralı yuva çağrılmaz (açık taraması 2026-10-19).
  if (zorla) calismaEnv = { ...calismaEnv, YALNIZ_SAGLAYICI: zorla };

  // Ayrılan pay ile gerçek maliyetin farkı her yolda yazılır. Ödeşme isteğin ömrüne bağlı (waitUntil): ziyaretçi
  // sekmeyi kapatıp bağlantıyı kopartsa da sürer, pay gün sonuna kadar kilitli kalmaz. Cevaplama hata verirse pay
  // tutulur (faturalanmış bir çağrı olmuş olabilir; temkinli yön).
  const harcamayiYaz = (gercek) => {
    const fark = (gercek || 0) - (izin.rezerve || 0);
    if (!fark) return Promise.resolve();
    return sayacaSor(env, { islem: "harca", usd: fark }).catch((e) => console.error(`harcama yazılamadı: ${e.message}`));
  };
  const is = cevapla(mesajlar, calismaEnv, govde?.dil === "en" ? "en" : "tr");
  const odesme = is.then((s) => harcamayiYaz(s.maliyetUsd), () => harcamayiYaz(izin.rezerve));
  if (ctx?.waitUntil) ctx.waitUntil(odesme);
  // İstatistik: türü, cevaplayan modeli ve dili (sınav sayılmaz). Ziyaretçinin cevabı bunu beklemez.
  if (!sinav) {
    const ist = is.then((s) => (s.durum === 200 ? { tur: s.tur, saglayici: s.saglayici, dil: govde?.dil === "en" ? "en" : "tr" } : { cevapsiz: true }),
      () => ({ cevapsiz: true }))
      .then((v) => sayacaSor(env, { islem: "sonuc", ...v }))
      .catch((e) => console.error(`istatistik yazılamadı: ${e.message}`));
    if (ctx?.waitUntil) ctx.waitUntil(ist);
    else await ist;
  }
  let sonuc;
  try {
    sonuc = await is;
  } catch (e) {
    console.error(`cevaplanamadı: ${e.message}`);
    if (!ctx?.waitUntil) await odesme;
    return json(gelistirme ? { hata: GENEL_HATA, ayrinti: e.message } : { hata: GENEL_HATA }, 503, cors);
  }
  if (!ctx?.waitUntil) await odesme;
  if (sonuc.durum !== 200) {
    console.error(`cevap yok: ${sonuc.hata} ${JSON.stringify(sonuc.denemeler)}`);
    // Yayında ziyaretçi iç ayrıntı görmez ("İletişim adresi ayarlanmadı." gibi): genel cümle gider.
    return json(gelistirme ? { hata: sonuc.hata, denemeler: sonuc.denemeler } : { hata: GENEL_HATA }, sonuc.durum, cors);
  }

  const sonMesaj = mesajlar[mesajlar.length - 1].content;
  // İşverenin, ikizin sorularına cevabı (Y): ziyaretçiye "kaydettim" ancak kayıt gerçekten açıldıysa denir, bu yüzden
  // beklenir. Düşerse dürüst cümle gider ve sayfa e-posta bağlantısını açar. Sınav isteği kayıt açmaz.
  if (sonuc.isverenCevabi && !sinav) {
    const k = await isverenCevabiniKaydet(sonMesaj, sonuc.sorular, env, oturum)
      .catch((e) => ({ kaydedildi: false, neden: e.message }));
    if (!k.kaydedildi && k.neden !== "bugün zaten kaydedildi") {
      console.error(`cevap kaydedilemedi: ${k.neden}`);
      sonuc.cevap = hazirCevap("Y-dustu", sonuc.dil, sonuc.eposta);
      sonuc.iletildi = true;
    }
  }
  // Bilinmeyen soru (C, K) bilgi deposuna kayda düşer; ziyaretçinin cevabı bunu beklemez. Sınav isteği kayıt açmaz
  // (canlı taramanın 20 sorusu kayda düşüp günlük kayıt hakkını yemişti, 2026-10-19).
  if (sonuc.iletildi && !sonuc.isverenCevabi && !sinav) {
    const kayit = soruyuKaydet(sonMesaj, sonuc.cevap, env)
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
  if (!sinav && env.IMZA_SIRRI) yanit.imza = await cevapImzasi(env.IMZA_SIRRI, oturum, sonuc.cevap);
  if (yeniJeton) yanit.oturum = yeniJeton;
  if (gelistirme || sinav) Object.assign(yanit, { tur: sonuc.tur, saglayici: sonuc.saglayici, ...(sonuc.bekci ? { bekci: sonuc.bekci } : {}) });
  return json(yanit, 200, cors);
}

export default { fetch: istegiIsle };
