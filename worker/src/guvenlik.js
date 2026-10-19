// Ara sunucunun güvenlik yardımcıları: IP anahtarı, imza, oturum jetonu, bot doğrulaması (Turnstile) ve cevap bekçisi.
// Yalnız Web standartları (crypto.subtle, fetch); Workers'ta da Node'da da çalışır.

// IPv6'da adres değiştirmek bedava (tek makinenin /64 bloğunda sayısız adres var): sınır /64 önekine uygulanır.
export function ipAnahtari(ip) {
  if (!ip || !ip.includes(":")) return ip || "yok";
  const [bas, son = ""] = ip.toLowerCase().split("::");
  const sol = bas ? bas.split(":") : [];
  const sag = son ? son.split(":") : [];
  const gruplar = [...sol, ...Array(Math.max(0, 8 - sol.length - sag.length)).fill("0"), ...sag];
  return gruplar.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

const kodla = new TextEncoder();
const anahtarlar = new Map();

async function hmac(sir, metin) {
  if (!anahtarlar.has(sir)) {
    anahtarlar.set(sir, await crypto.subtle.importKey("raw", kodla.encode(sir), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  const imza = await crypto.subtle.sign("HMAC", anahtarlar.get(sir), kodla.encode(metin));
  return [...new Uint8Array(imza)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// Sabit süreli karşılaştırma: imza harf harf tahmin edilemesin.
export function esit(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let fark = 0;
  for (let i = 0; i < a.length; i++) fark |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return fark === 0;
}

// İkizin her cevabı oturuma bağlı imzayla döner; sayfa geçmişi geri yollarken imzayı da yollar. İmzası tutmayan
// "asistan" mesajı reddedilir: ziyaretçi ikizin ağzına sahte önceki cevap koyamaz.
export const cevapImzasi = (sir, oturum, cevap) => hmac(sir, `cevap\n${oturum}\n${cevap}`);
export async function cevapImzasiDogru(sir, oturum, cevap, imza) {
  return esit(await cevapImzasi(sir, oturum, cevap), imza);
}

export const OTURUM_OMRU_MS = 2 * 60 * 60 * 1000;

export async function oturumOlustur(sir, simdi = Date.now()) {
  const kimlik = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const bitis = simdi + OTURUM_OMRU_MS;
  return { kimlik, jeton: `${kimlik}.${bitis}.${await hmac(sir, `oturum\n${kimlik}\n${bitis}`)}` };
}

// Geçerliyse oturum kimliği, değilse null.
export async function oturumDogrula(sir, jeton, simdi = Date.now()) {
  if (typeof jeton !== "string") return null;
  const [kimlik, bitis, imza] = jeton.split(".");
  if (!/^[0-9a-f]{24}$/.test(kimlik || "") || !(Number(bitis) > simdi)) return null;
  return esit(await hmac(sir, `oturum\n${kimlik}\n${bitis}`), imza) ? kimlik : null;
}

// Cloudflare Turnstile: sayfadaki görünmez doğrulamanın jetonu sunucuda bir kez sınanır.
export async function turnstileDogrula(sir, jeton, ip, alan = "bora-eem.github.io") {
  if (typeof jeton !== "string" || !jeton || jeton.length > 4096) return false;
  try {
    const yanit = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ secret: sir, response: jeton, ...(ip ? { remoteip: ip } : {}) }),
    });
    const veri = await yanit.json();
    if (!veri.success) console.error(`turnstile reddetti: ${(veri["error-codes"] || []).join(",")}`);
    if (veri.success && veri.hostname !== alan) {
      console.error(`turnstile başka alan adından: ${veri.hostname}`);
      return false;
    }
    return veri.success === true;
  } catch (e) {
    console.error(`turnstile sınanamadı: ${e.message}`);
    return false;
  }
}

// --- Cevap bekçisi -------------------------------------------------------------------------------------------
// Model kuralı çiğnese bile ziyaretçiye gitmeyecek şeyler: bilgi dosyasında olmayan sayı (maaş, tarih, telefon),
// izinsiz bağlantı ya da e-posta, Bora adına söz. Bekçiye takılan cevap "benimle konuşun" hazır cevabına döner.

const SAYI = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
// Para ya da çarpan: bilgide geçmiyorsa (yazıyla "seksen bin lira" dahil) durur; sayıyı yazıyla vermek atlatmasın.
const PARA = /(?<![\p{L}])(bin|milyon|milyar|lira|tl|try|dolar|euro|avro|usd|eur|salary|thousand|million|k)(?![\p{L}])|[₺$€£]/gu;
// Belirli bir gün ("3 Kasım", "November 3rd"): bilgide yoksa Bora adına tarih verilmiş demektir.
const GUN = /(?<!\p{Nd})\p{Nd}{1,2}\s*(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\p{Nd}{1,2}(?!\p{Nd})/gu;
// Öz puan ("10 üzerinden 8", "8/10", "8 out of 10"): bilgide aynı kalıp yoksa Bora adına kendine not vermiştir
// (sınav 2026-10-19: "Python'da kendime 10 üzerinden 8 veririm", bilgide yok).
const PUAN = /(?<!\p{Nd})\p{Nd}{1,3}\s*(?:üzerinden|out\s+of)\s*\p{Nd}{1,3}(?!\p{Nd})|(?<![\p{Nd},.])\p{Nd}{1,2}\s*\/\s*(?:5|10|100)(?![\p{Nd},.])/gu;
// Ölçüm yöntemi adı: bilgide geçmiyorsa model bir doğrulama yöntemi uydurmuştur (sınav 2026-10-19: "%96'yı çapraz
// doğrulamayla ölçtüm", bilgide yöntem yok).
const YONTEM = /(?<!\p{L})(çapraz doğrulama\p{L}*|cross[- ]?validat\p{L}*|k-fold|test set\p{L}*|doğrulama set\p{L}*|validation set|f1[- ]?(?:skor|score)\p{L}*|karışıklık matris\p{L}*|confusion matrix|roc eğri\p{L}*|roc curve|auc)(?!\p{L})/giu;
// İç talimat sızıntısı: istemin ya da bilgi dosyasının ikize yönelik cümleleri ziyaretçiye gitmez.
const IC_TALIMAT = [/İkizin söylemeyecekleri/u, /liste kapalıdır/iu, /satırı söylenir/iu, /CEVAP KURALLARI/u, /SORUNUN TÜRÜNÜ/u,
  /\bBİLGİ\b/u, /"tur"\s*:/u, /yalnız sorulursa söylenir/iu, /ilgi alanı olarak sayılmaz/iu];
const BAGLANTI = /\bhttps?:\/\/[^\s)>\]"']+|\bwww\.[^\s)>\]"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|site|xyz|info|me|co|tr|ai|ly|gg|to|sh|st|cc|gl|im|so|ws|tv|fm|biz|link|page|top|online|store|shop|tech|live|click|eu|uk|us|de|ru|cn)(?![\p{L}\p{N}])(?:\/[^\s)>\]"']*)?/giu;
const EPOSTA = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TELEFON = /(?:\+?90[\s.-]?)?\(?0?5\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/;
// Söz kalıpları küçük harfe indirilmiş metinde aranır (Türkçe için "tr" yereliyle: "BAŞLIYORUM" da yakalanır).
const SOZ = [
  /kabul\s+ed(?:iyorum|erim|ebilirim|eriz)/u, /teklif\p{L}*\s+(?:kabul|uygun|tamam)/u, /anlaştık/u, /söz\s+veriyorum/u,
  /onaylıyorum/u, /(?<!\p{L})başlıyorum(?!\p{L})/u, /(?<!\p{L})başlayacağım(?!\p{L})/u, /tamam,?\s+anlaşt/u,
  /imzalar(?:ım|ız)(?!\p{L})/u, /imzalayabilirim/u, /sözleşme\p{L}*\s+(?:imzala|tamam|uygun)/u,
  /\bi\s+(?:accept|agree|confirm|promise)\b/, /\bconfirmed\b/, /\bit'?s\s+a\s+deal\b/, /\bi(?:'ll| will)\s+start\s+on\b/,
  /\bi(?:'ll| will)\s+sign\b/,
];

// Unicode rakamlar (٨٠, ８０) ve tam genişlikli harfler NFKC ile ASCII'ye iner; Arapça-Hint rakamları elle.
const normalize = (m) => m.normalize("NFKC").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String((c.charCodeAt(0) & 0xf) % 10));
const sayiBicim = (s) => s.replace(/(\d)[.,](?=\d{3}\b)/g, "$1").replace(",", ".").replace(/^0+(?=\d)/, "");

function sayilar(metin) {
  // Önce e-posta: bağlantı önce silinirse adresin alan adı gider, rakamlı yerel kısım (öğrenci numarası) sayı kalır.
  return new Set((metin.replace(EPOSTA, " ").replace(BAGLANTI, " ").match(SAYI) || []).map(sayiBicim));
}
const kumele = (metin, desen) => new Set((metin.match(desen) || []).map((x) => x.trim()));

const bilgiOnbellegi = { metin: null, sayilar: null, baglantilar: null, para: null, gunler: null, puanlar: null, yontemler: null };
const yalinBaglanti = (b) => b.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[.,;:]+$/, "");

export function cevapBekcisi(hamCevap, bilgi, eposta, hamSoru = "") {
  if (bilgiOnbellegi.metin !== bilgi) {
    const kucuk = normalize(bilgi).toLocaleLowerCase("tr");
    Object.assign(bilgiOnbellegi, {
      metin: bilgi,
      sayilar: sayilar(normalize(bilgi)),
      baglantilar: (bilgi.match(BAGLANTI) || []).map(yalinBaglanti),
      para: kumele(kucuk, PARA),
      gunler: kumele(kucuk, GUN),
      puanlar: kumele(kucuk, PUAN),
      yontemler: kumele(kucuk, YONTEM),
    });
  }
  const cevap = normalize(hamCevap);
  const soru = normalize(hamSoru);
  const kucukTr = cevap.toLocaleLowerCase("tr");
  const kucukEn = cevap.toLowerCase();
  if (TELEFON.test(cevap)) return { gecti: false, neden: "telefon kalıbı" };
  for (const desen of IC_TALIMAT) if (desen.test(cevap)) return { gecti: false, neden: `iç talimat sızıntısı: ${desen}` };
  for (const e of cevap.match(EPOSTA) || []) {
    if (e.toLowerCase() !== eposta.toLowerCase()) return { gecti: false, neden: `izinsiz e-posta: ${e}` };
  }
  // Bağlantı: alan adı tam eşleşmeli ("gmail.com.kotu.io" geçmez); yol varsa bilgideki bağlantının ta kendisi ya da
  // onun başı olmalı ("linkedin.com/in/baska-biri" geçmez).
  const epostaAlani = eposta.toLowerCase().split("@")[1];
  for (const b of cevap.match(BAGLANTI) || []) {
    const yalin = yalinBaglanti(b);
    if (yalin === epostaAlani) continue;
    const [alan] = yalin.split("/");
    const izinli = bilgiOnbellegi.baglantilar.some((i) => i === yalin || (i.split("/")[0] === alan && (yalin === alan || i.startsWith(yalin + "/"))));
    if (!izinli) return { gecti: false, neden: `izinsiz bağlantı: ${b}` };
  }
  for (const p of kumele(kucukTr, PARA)) {
    if (!bilgiOnbellegi.para.has(p)) return { gecti: false, neden: `bilgide olmayan para/çarpan: ${p}` };
  }
  for (const g of kumele(kucukTr, GUN)) {
    if (!bilgiOnbellegi.gunler.has(g)) return { gecti: false, neden: `bilgide olmayan gün: ${g}` };
  }
  for (const pu of kumele(kucukTr, PUAN)) {
    if (!bilgiOnbellegi.puanlar.has(pu)) return { gecti: false, neden: `bilgide olmayan puan: ${pu}` };
  }
  for (const y of kumele(kucukTr, YONTEM)) {
    if (!bilgiOnbellegi.yontemler.has(y)) return { gecti: false, neden: `bilgide olmayan yöntem: ${y}` };
  }
  // Ziyaretçinin kendi sorusundaki küçük sayılar ("5 yıl sonra") tekrar edilebilir; büyük sayılar (maaş) edilemez.
  const soruSayilari = new Set([...sayilar(soru)].filter((n) => n.replace(".", "").length <= 2));
  for (const n of sayilar(cevap)) {
    if (!bilgiOnbellegi.sayilar.has(n) && !soruSayilari.has(n)) return { gecti: false, neden: `bilgide olmayan sayı: ${n}` };
  }
  for (const desen of SOZ) if (desen.test(kucukTr) || desen.test(kucukEn)) return { gecti: false, neden: `söz ifadesi: ${desen}` };
  return { gecti: true };
}
