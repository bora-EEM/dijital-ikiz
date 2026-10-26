// Kalıcı sayaç: günlük soru sınırları, paralı model harcaması, issue spam engeli ve bilgi dosyasının yedeği.
// Yayında tek bir Cloudflare Durable Object ("genel") bütün sunucu örnekleri için ortak sayar; yerelde ve testlerde
// aynı mantık bellekte koşar. Sayaçlar gün değişince silinir; yalnız bilgi yedeği kalır.
// Not: "cloudflare:workers" içe aktarılmaz (Node'da yerel sunucu ve testler de bu dosyayı yükler); klasik
// fetch arayüzlü Durable Object yeterli.
// İstatistik (Bora'nın isteği 2026-10-19): günlük isimsiz toplamlar "ist:<gün>" anahtarında, gün değişince silinmez,
// 180 gün tutulur. Kişi, IP ya da soru metni yazılmaz. Tekil sayım yalnız bot doğrulamasından geçmiş sohbette (izin);
// doğrulamasız sayfa açılışı tek anahtara ve günlük tavanla yazılır: sayacı döven depo yazma sınırını tüketemesin.
// Oturum kaydı (Bora'nın kararı 2026-10-21): bot doğrulamasından geçmiş her oturumun soruları ve cevapları "ot:<kimlik>"
// anahtarında. Kimlik oturumun özetidir (IP değil); sorudaki e-posta ve telefon yazılmadan önce gizlenir (index.js).
// Bora'nın bilgisayarı haftada bir alıp siler; alınmasa da 14 günü geçen kayıt gün değişiminde silinir.
// Açılış kaydı (Bora'nın kararı 2026-10-26, "en etik yoldan"): her sayfa açılışı "ac:<kimlik>" anahtarında; kimlik
// sayfanın o açılış için ürettiği rastgele sayıdır (çerez yok, iki ziyaret birbirine bağlanamaz). Yalnız dakika, ülke,
// internetin geldiği kurum (şirket ağı ya da internet sağlayıcısı), cihaz türü, dil, robot olabilir mi, kalma süresi, soru sayısı ve sayfada yaşanan sorunlar
// (bot doğrulaması yüklenmedi, sunucuya ulaşılamadı). IP, tarayıcı kimliği ve adres yolu yazılmaz; 14 günde silinir.

export const VARSAYILAN = {
  gunlukSoru: 400,     // bütün ziyaretçiler, gün başına (normal kullanım: gün başına birkaç İK sohbeti × 10–20 soru)
  davetGunluk: 300,    // özgeçmişteki davet koduyla gelenlerin ayrı havuzu: anonim havuz dolsa da açık kalır
  ipGunluk: 60,        // aynı IP (IPv6'da /64) gün başına
  oturumSoru: 20,      // bir oturum (bot doğrulamasından geçmiş bir sayfa açılışı)
  gunlukKayit: 30,     // gün başına en çok bu kadar "cevaplanamadı" issue'su
  gunlukIsverenCevabi: 10, // işverenin, ikizin sorularına cevabı: ayrı tavan (bu yol bilinmeyen soruların hakkını yiyemez)
  oturumIsverenCevabi: 2,  // bir oturumdan en çok bu kadar işveren cevabı
  gunlukButceUsd: 1,   // paralı model günde en çok bu kadar; dolunca ücretsiz yuvalara düşülür (ikiz susmaz)
};

const sayi = (deger, varsayilan) => {
  const n = Number(deger);
  return Number.isFinite(n) && n >= 0 ? n : varsayilan;
};

export function sinirlar(env = {}) {
  return {
    gunlukSoru: sayi(env.GUNLUK_SORU, VARSAYILAN.gunlukSoru),
    davetGunluk: sayi(env.DAVET_GUNLUK, VARSAYILAN.davetGunluk),
    ipGunluk: sayi(env.IP_GUNLUK, VARSAYILAN.ipGunluk),
    oturumSoru: sayi(env.OTURUM_SORU, VARSAYILAN.oturumSoru),
    gunlukKayit: sayi(env.GUNLUK_KAYIT, VARSAYILAN.gunlukKayit),
    gunlukIsverenCevabi: sayi(env.GUNLUK_ISVEREN_CEVABI, VARSAYILAN.gunlukIsverenCevabi),
    oturumIsverenCevabi: sayi(env.OTURUM_ISVEREN_CEVABI, VARSAYILAN.oturumIsverenCevabi),
    gunlukButceUsd: sayi(env.GUNLUK_BUTCE_USD, VARSAYILAN.gunlukButceUsd),
  };
}

const bugun = () => new Date().toISOString().slice(0, 10);
const IST_GUN = 180;
const ACILIS_TAVANI = 1000; // havuz başına günlük; aşılınca sayılmaz, sayfa "≥" gösterir
const OTURUM_GUN = 14;
// Oturum başına en çok bu kadar soru-cevap (oturum soru sınırı günde 20; gece yarısını aşan oturum 40'a çıkabilir,
// fazlası "kesik" sayılır, sayfada görünür). SQLite tabanlı Durable Object'te değer sınırı 2 MB, 30 kayıt ~160 KB.
const OTURUM_MESAJ = 30;
const SORU_UZUNLUK = 600, CEVAP_UZUNLUK = 2000;
// Açılış başına en çok bu kadar sorun kaydı; olay adları sabit listeden, ayrıntı kısa kod.
const ACILIS_OLAY = 12;
const OLAYLAR = new Set(["dogrulama", "dogrulamaSunucu", "ag", "sunucu", "sinir", "iletisim"]);
const kimlikMi = (k) => /^[0-9a-f]{16}$/.test(String(k || ""));
const dakika = () => new Date().toISOString().slice(0, 16) + ":00.000Z";

// Sorun ucundan (sayfanın ilk isteği düştüyse) açılan kayıt için ayrı, küçük tavan: o uç doğrulamasız, rastgele
// kimliklerle dövülse de gün içinde en çok bu kadar kayıt açar; sayfa açılışından gelen kayıtlar ziyaret tavanına
// bağlı (havuz başına 1000) ve bundan etkilenmez. Normal günde ilk isteği düşen açılış birkaç tanedir.
const SORUNDAN_KAYIT = 200;

// Açılışın kaydı yoksa açılır. "tavan" verilirse o sayaçla sınırlı; verilmezse (sunucunun kendi gözlemi) yalnız var olan
// kayda yazılır, yeni kayıt açılmaz.
async function acilisKaydi(depo, gun, kimlik, bilgi, tavan = null) {
  const a = `ac:${kimlik}`;
  const onceki = await depo.get(a);
  if (onceki || !tavan) return onceki || null;
  const ist = (await depo.get(`ist:${gun}`)) || {};
  if ((ist[tavan.sayac] || 0) >= tavan.sinir) return null;
  await istArtir(depo, gun, [[tavan.sayac]]);
  const b = bilgi || {};
  const kayit = {
    kimlik, zaman: dakika(), davet: Boolean(b.davet),
    kurum: String(b.kurum || "").slice(0, 80), ulke: String(b.ulke || "").slice(0, 2), cihaz: String(b.cihaz || "").slice(0, 12),
    dil: String(b.dil || "").slice(0, 3), robot: Boolean(b.robot), soru: 0, olaylar: [],
  };
  await depo.put(a, kayit);
  return kayit;
}

// yollar: ["soru"] ya da ["tur", "A"] biçiminde; ikincisi alt sayaç (tür, sağlayıcı, dil, sınır kodu).
// Sayım hatası ziyaretçinin sorusunu düşürmez: günlüğe yazılır, geçilir.
async function istArtir(depo, gun, yollar) {
  try {
    const a = `ist:${gun}`;
    const ist = (await depo.get(a)) || {};
    for (const [k, alt] of yollar) {
      if (alt === undefined) ist[k] = (ist[k] || 0) + 1;
      else ist[k] = { ...(ist[k] || {}), [alt]: ((ist[k] || {})[alt] || 0) + 1 };
    }
    await depo.put(a, ist);
  } catch (e) {
    console.error(`istatistik yazılamadı: ${e.message}`);
  }
}

// Depo arayüzü: get(anahtar), put(anahtar, deger), list() → Map, delete(anahtarlar[]). Durable Object'in storage'ı da
// bellekteki Map de bu arayüzü sağlar.
async function gunuTazele(depo, gun) {
  const onceki = await depo.get("gun");
  if (onceki === gun) return;
  // Biten günün harcaması istatistiğe geçer (günlük "usd" sayacı birazdan silinir).
  const usd = await depo.get("usd");
  if (onceki && usd) await depo.put(`ist:${onceki}`, { ...((await depo.get(`ist:${onceki}`)) || {}), usd });
  const sinir = new Date(Date.parse(gun) - IST_GUN * 86_400_000).toISOString().slice(0, 10);
  const otSinir = new Date(Date.parse(gun) - OTURUM_GUN * 86_400_000).toISOString();
  const eski = [...(await depo.list()).entries()].filter(([a, d]) => a !== "bilgi" && a !== "gun"
    && (!a.startsWith("ist:") || a.slice(4) < sinir)
    && (!a.startsWith("ot:") || String(d?.son || "") < otSinir)
    && (!a.startsWith("ac:") || String(d?.zaman || "") < otSinir)).map(([a]) => a);
  // Durable Object deposu tek çağrıda en çok 128 anahtar siler (fazlası hata, ikiz gün boyu susardı; inceleme 2026-10-13).
  for (let i = 0; i < eski.length; i += 128) await depo.delete(eski.slice(i, i + 128));
  await depo.put("gun", gun);
}

export async function sayacIslem(depo, env, istek) {
  const s = sinirlar(env);
  const gun = bugun();
  await gunuTazele(depo, gun);
  const al = async (a) => (await depo.get(a)) ?? 0;

  switch (istek.islem) {
    case "izin": {
      // Önce hepsine bak, sonra hepsini artır: reddedilen soru hiçbir sayaçtan düşmesin.
      // Davet koduyla gelen (özgeçmişteki bağlantı) ayrı havuzdan yer: anonim havuzu dolduran onu kapatamaz.
      const havuz = istek.davet ? "davet" : "soru";
      const genel = await al(havuz);
      const ek = istek.davet ? "Davet" : "";
      // Reddedilen soru istatistikte "sınıra takıldı" olarak sayılır (sınav sayılmaz).
      const reddet = async (kod) => {
        if (!istek.sinav) await istArtir(depo, gun, [["durdu", kod]]);
        return { tamam: false, kod };
      };
      if (genel >= (istek.davet ? s.davetGunluk : s.gunlukSoru)) return reddet("genel");
      const oturumSayisi = istek.oturum ? await al(`o:${istek.oturum}`) : 0;
      if (!istek.sinav) {
        if ((await al(`ip:${istek.ip}`)) >= s.ipGunluk) return reddet("gunluk");
        if (istek.oturum && oturumSayisi >= s.oturumSoru) return reddet("oturum");
      }
      await depo.put(havuz, genel + 1);
      if (!istek.sinav) {
        await depo.put(`ip:${istek.ip}`, (await al(`ip:${istek.ip}`)) + 1);
        if (istek.oturum) await depo.put(`o:${istek.oturum}`, oturumSayisi + 1);
        // Oturumun ilk sorusu "sohbet" sayılır: kaç sohbet açıldı, kaç soru soruldu.
        await istArtir(depo, gun, [[`soru${ek}`], ...(istek.oturum && !oturumSayisi ? [[`sohbet${ek}`]] : [])]);
      }
      // Bütçe aynı turda: sayaca soru başına tek gidiş. Paralı yuva kullanılabilecekse en kötü maliyet önce
      // ayrılır (rezerve), gerçek maliyet gelince fark "harca" ile düzeltilir: aynı anda gelen sorular eski toplamı
      // görüp tavanı aşamaz (saldırı denemesi 2026-10-19). Durable Object tek iş parçacığında: ayırma atomik.
      const usd = await al("usd");
      const rezerve = Math.max(0, Number(istek.rezerve) || 0);
      const butceDoldu = usd + rezerve > s.gunlukButceUsd;
      if (!butceDoldu && rezerve) await depo.put("usd", usd + rezerve);
      return { tamam: true, butceDoldu, rezerve: butceDoldu ? 0 : rezerve };
    }
    case "ziyaret": {
      // Sayfa açılışı (sayfa iletişim adresini isterken; doğrulamasız). Yalnız toplam, havuz başına günlük tavanla.
      const ek = istek.davet ? "Davet" : "";
      const ist = (await depo.get(`ist:${gun}`)) || {};
      if ((ist[`ziyaret${ek}`] || 0) >= ACILIS_TAVANI) return { tamam: true, tavan: true };
      await istArtir(depo, gun, [[`ziyaret${ek}`]]);
      // Ziyaretçi izlenmek istemediğini söylediyse (GPC, DNT) sayfa kimlik göndermez: yalnız toplam artar.
      if (kimlikMi(istek.acilis?.kimlik)) {
        await acilisKaydi(depo, gun, istek.acilis.kimlik, { ...istek.acilis, davet: istek.davet }, { sayac: "acilisKaydi", sinir: Infinity });
      }
      return { tamam: true };
    }
    case "acilisOlay": {
      // Sayfadan gelen sorun kaydı ya da kalma süresi. Kayıt hatası ziyaretçiyi etkilemez (sayfa cevabı okumaz).
      if (!kimlikMi(istek.kimlik)) return { tamam: false, neden: "kimlik" };
      // Sayfadan gelen olay kaydı açabilir (ilk istek düştüyse), sunucunun kendi gözlemi açamaz (bilgi yok).
      const ac = await acilisKaydi(depo, gun, istek.kimlik, istek.bilgi,
        istek.bilgi ? { sayac: "acilisKaydiSorundan", sinir: SORUNDAN_KAYIT } : null);
      if (!ac) return { tamam: false, neden: istek.bilgi ? "tavan" : "kayit yok" };
      if (istek.olay === "ayrildi") {
        // Kalma süresi saniye, en çok bir gün; sekme her gizlendiğinde gelir, en büyüğü kalır.
        const sure = Math.min(86_400, Math.max(0, Math.round(Number(istek.sure) || 0)));
        if (sure > (ac.sure || 0)) { ac.sure = sure; await depo.put(`ac:${istek.kimlik}`, ac); }
        return { tamam: true };
      }
      if (!OLAYLAR.has(istek.olay)) return { tamam: false, neden: "olay" };
      if (ac.olaylar.length >= ACILIS_OLAY) return { tamam: false, neden: "dolu" };
      ac.olaylar.push({ zaman: dakika(), olay: istek.olay, ayrinti: String(istek.ayrinti || "").replace(/[^a-z0-9-]/gi, "").slice(0, 40) });
      await depo.put(`ac:${istek.kimlik}`, ac);
      return { tamam: true };
    }
    case "acilislar": {
      // Bora'nın bilgisayarı saatte bir okur; 14 günü geçen kayıt burada da silinir.
      const sinir = new Date(Date.now() - OTURUM_GUN * 86_400_000).toISOString();
      const hepsi = [...(await depo.list({ prefix: "ac:" })).entries()].filter(([a]) => a.startsWith("ac:"));
      const eski = hepsi.filter(([, d]) => String(d?.zaman || "") < sinir).map(([a]) => a);
      for (let i = 0; i < eski.length; i += 128) await depo.delete(eski.slice(i, i + 128));
      const kalan = hepsi.filter(([a]) => !eski.includes(a)).map(([, d]) => d);
      return { acilislar: kalan.sort((x, y) => (x.zaman < y.zaman ? 1 : -1)) };
    }
    case "sonuc": {
      // Cevabın türü, cevaplayan model ve dil; cevap verilemediyse "cevapsiz". Metin yazılmaz.
      const yollar = istek.cevapsiz ? [["cevapsiz"]]
        : [["tur", String(istek.tur || "?")], ["saglayici", String(istek.saglayici || "?")], ["dil", String(istek.dil || "?")]];
      await istArtir(depo, gun, yollar);
      return { tamam: true };
    }
    case "oturumYaz": {
      // Bir soru-cevap oturumun kaydına eklenir. Kayıt hatası ziyaretçiyi etkilemez (çağıran yutar, günlüğe yazar).
      if (!kimlikMi(istek.kimlik)) return { tamam: false, neden: "kimlik" };
      const a = `ot:${istek.kimlik}`;
      const zaman = String(istek.zaman || new Date().toISOString()).slice(0, 30);
      const ot = (await depo.get(a)) || { kimlik: istek.kimlik, baslangic: zaman, davet: Boolean(istek.davet), mesajlar: [] };
      if (ot.mesajlar.length >= OTURUM_MESAJ) {
        ot.kesik = (ot.kesik || 0) + 1;
        await depo.put(a, ot);
        return { tamam: false, neden: "oturum dolu" };
      }
      ot.son = zaman;
      if (istek.davet) ot.davet = true;
      // Soru, sorulduğu açılışa da yazılır: hangi açılış sohbete döndü (açılış kaydı yoksa ya da izin yoksa geçilir).
      if (kimlikMi(istek.acilis)) {
        const ac = await depo.get(`ac:${istek.acilis}`);
        if (ac) { ac.soru = (ac.soru || 0) + 1; ac.oturum = istek.kimlik; await depo.put(`ac:${istek.acilis}`, ac); }
        ot.acilis = istek.acilis;
      }
      ot.mesajlar.push({
        zaman,
        soru: String(istek.soru || "").slice(0, SORU_UZUNLUK),
        cevap: istek.cevapsiz ? null : String(istek.cevap || "").slice(0, CEVAP_UZUNLUK),
        tur: istek.cevapsiz ? null : String(istek.tur || "?").slice(0, 4),
        model: istek.cevapsiz ? null : String(istek.saglayici || "?").slice(0, 80),
        dil: istek.dil === "en" ? "en" : "tr",
      });
      await depo.put(a, ot);
      return { tamam: true };
    }
    case "oturumlar": {
      // Bora'nın bilgisayarı saatte bir okur: 14 günü geçen kayıt burada da silinir (gün değişimini beklemez).
      const otSinir = new Date(Date.now() - OTURUM_GUN * 86_400_000).toISOString();
      const hepsi = [...(await depo.list({ prefix: "ot:" })).entries()].filter(([a]) => a.startsWith("ot:"));
      const eski = hepsi.filter(([, d]) => String(d?.son || "") < otSinir).map(([a]) => a);
      for (let i = 0; i < eski.length; i += 128) await depo.delete(eski.slice(i, i + 128));
      const kalan = hepsi.filter(([a]) => !eski.includes(a)).map(([, d]) => d);
      return { oturumlar: kalan.sort((x, y) => (x.baslangic < y.baslangic ? 1 : -1)) };
    }
    case "oturumSil": {
      // Bora'nın bilgisayarı kendi arşivine yazıp geri okuduktan sonra siler; yalnız "ot:" anahtarları silinebilir.
      // Karşılaştır-sil: kayıt arşivlenen hâlinden sonra büyüdüyse (son değişti) silinmez, bir sonraki arşive kalır.
      const silinecek = [];
      for (const k of Array.isArray(istek.kayitlar) ? istek.kayitlar : []) {
        if (!/^[0-9a-f]{16}$/.test(String(k?.kimlik))) continue;
        const d = await depo.get(`ot:${k.kimlik}`);
        if (d && d.son === k.son) silinecek.push(`ot:${k.kimlik}`);
      }
      for (let i = 0; i < silinecek.length; i += 128) await depo.delete(silinecek.slice(i, i + 128));
      return { silinen: silinecek.length };
    }
    case "istatistik": {
      const gunler = [...(await depo.list({ prefix: "ist:" })).entries()].filter(([a]) => a.startsWith("ist:"))
        .map(([a, d]) => ({ gun: a.slice(4), ...d })).sort((x, y) => (x.gun < y.gun ? 1 : -1));
      const bugunku = gunler.find((g) => g.gun === gun);
      if (bugunku) bugunku.usd = await al("usd");
      return { gunler };
    }
    case "butce": {
      const usd = await al("usd");
      return { usd, doldu: usd >= s.gunlukButceUsd };
    }
    case "harca": {
      // Fark eksi olabilir (ayrılan pay gerçek maliyetten büyükse); toplam sıfırın altına inmez.
      const usd = Math.max(0, (await al("usd")) + (Number(istek.usd) || 0));
      await depo.put("usd", usd);
      return { usd };
    }
    case "kayit": {
      if (await depo.get(`k:${istek.anahtar}`)) return { izin: false, neden: "bugün zaten kaydedildi" };
      const cevap = istek.tur === "cevap";
      const sayacAdi = cevap ? "kayitY" : "kayit";
      const n = await al(sayacAdi);
      if (n >= (cevap ? s.gunlukIsverenCevabi : s.gunlukKayit)) return { izin: false, neden: "günlük kayıt tavanı" };
      const oturumAdi = cevap && istek.oturum ? `y:${istek.oturum}` : null;
      if (oturumAdi && (await al(oturumAdi)) >= s.oturumIsverenCevabi) return { izin: false, neden: "oturum kayıt tavanı" };
      await depo.put(sayacAdi, n + 1);
      if (oturumAdi) await depo.put(oturumAdi, (await al(oturumAdi)) + 1);
      await depo.put(`k:${istek.anahtar}`, 1);
      return { izin: true };
    }
    case "kayitBirak": {
      // GitHub'a yazılamayan kayıt hakkı geri verilir: aynı metin yeniden denenebilsin, "zaten kaydedildi" yalan olmasın.
      if (!(await depo.get(`k:${istek.anahtar}`))) return { tamam: true };
      await depo.delete([`k:${istek.anahtar}`]);
      const sayacAdi = istek.tur === "cevap" ? "kayitY" : "kayit";
      await depo.put(sayacAdi, Math.max(0, (await al(sayacAdi)) - 1));
      if (istek.tur === "cevap" && istek.oturum) await depo.put(`y:${istek.oturum}`, Math.max(0, (await al(`y:${istek.oturum}`)) - 1));
      return { tamam: true };
    }
    case "bilgiYaz":
      if ((await depo.get("bilgi")) !== istek.metin) await depo.put("bilgi", istek.metin);
      return { tamam: true };
    case "bilgiOku":
      return { metin: (await depo.get("bilgi")) ?? null };
    default:
      return { hata: "bilinmeyen işlem" };
  }
}

// Bellekteki depo: yerel sunucu ve testler için. Sunucu örneği kapanınca sayaçlar sıfırlanır.
export function bellekDeposu() {
  const m = new Map();
  return {
    get: async (a) => m.get(a),
    put: async (a, d) => { m.set(a, d); },
    list: async ({ prefix = "" } = {}) => new Map([...m].filter(([a]) => a.startsWith(prefix))),
    delete: async (anahtarlar) => {
      if (anahtarlar.length > 128) throw new Error("tek çağrıda en çok 128 anahtar"); // Durable Object ile aynı sınır
      for (const a of anahtarlar) m.delete(a);
    },
  };
}

const yerelDepo = bellekDeposu();
let uyarildi = false;

// Sunucu kodu sayaca hep bununla gider: yayında Durable Object, yoksa bellek. Sayaç ulaşılamazsa hata yukarı gider
// (çağıran karar verir: soru sınırında kapalı kal, yedekte yoksay).
export async function sayacaSor(env, istek) {
  if (env.SAYAC) {
    const nesne = env.SAYAC.get(env.SAYAC.idFromName("genel"));
    const yanit = await nesne.fetch("https://sayac/islem", { method: "POST", body: JSON.stringify(istek) });
    if (!yanit.ok) throw new Error(`sayaç HTTP ${yanit.status}`);
    return yanit.json();
  }
  if (!uyarildi && env.GELISTIRME !== "1") {
    console.error("SAYAC bağlaması yok: sayaçlar bellekte, örnek başına (yayında olmamalı)");
    uyarildi = true;
  }
  return sayacIslem(env.__depo || yerelDepo, env, istek);
}

// Cloudflare Durable Object sınıfı (wrangler.toml: SAYAC → Sayac). İstekler tek sırada işlenir; sayaç yarışı yok.
export class Sayac {
  constructor(state, env) {
    this.depo = state.storage;
    this.env = env;
  }

  async fetch(istek) {
    const govde = await istek.json();
    return Response.json(await sayacIslem(this.depo, this.env, govde));
  }
}
