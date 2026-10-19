// Ara sunucunun adresi: yerelde aynı köken, yayında Cloudflare Workers.
const YEREL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = YEREL ? "/api/sohbet" : "https://dijital-ikiz.koruyucubora.workers.dev/api/sohbet";
// İletişim adresi açık depoda durmaz: sunucunun gizli ayarından gelir (Bora'nın kararı 2026-10-19). Gelene kadar
// e-posta bağlantısı gizli kalır; gelmezse de gizli kalır, yanlış adres gösterilmez.
const ILETISIM = API.replace(/sohbet$/, "iletisim");
// Özgeçmişteki bağlantının davet kodu (?d=…): bu sekmede hatırlanır, her soruyla gider; ayrı günlük kota sağlar.
const DAVET = (() => {
  const d = new URLSearchParams(location.search).get("d");
  try {
    if (d) {
      sessionStorage.setItem("davet", d);
      // Kod adres çubuğunda kalmasın: ekran görüntüsüyle ya da paylaşılan bağlantıyla yayılmasın.
      const temiz = new URL(location.href);
      temiz.searchParams.delete("d");
      history.replaceState(null, "", temiz);
    }
    return d || sessionStorage.getItem("davet") || "";
  } catch { return d || ""; }
})().slice(0, 64);
let EPOSTA = "";
const LINKEDIN = "https://www.linkedin.com/in/bora-koruyucu-558a09260/";
// Görünmez bot doğrulaması (Cloudflare Turnstile); site anahtarı herkese açıktır. Yerelde sunucu doğrulama istemez.
const TURNSTILE_SITE = YEREL ? "" : "0x4AAAAAAFVCNnDn_94RaIB7";
const OTURUM_SINIRI = 20;
const ZAMAN_ASIMI_MS = 35000;

const METIN = {
  tr: {
    rozet: "Yapay zekâ ikizi",
    alt: "Bana ne sormak isterseniz sorun; ikizim benim yerime, benim onayladığım bilgilerle cevaplar.",
    yer: "Bir soru yazın…",
    oneriler: ["Hangi projeleri yaptın?", "Ne zaman ve nerede staj yapabilirsin?", "Yapay zekâyı işinde nasıl kullanıyorsun?"],
    bilgiDugme: "Neler kaydedilir ⓘ",
    bilgi: "Bu bir yapay zekâ. Cevaplar yalnız Bora'nın onayladığı bilgilerden gelir; bilmediği bir şey sorulursa uydurmaz, sizi Bora'ya yönlendirir. Cevaplayamadığı sorular ikizi geliştirmek için, ikizin size sorduğu sorulara verdiğiniz cevaplar da Bora okusun diye isimsiz kaydedilir (ad ya da sohbetin geri kalanı tutulmaz). Kötüye kullanımı önlemek için IP adresiniz yalnız günlük soru sayacında tutulur ve en geç ertesi gün silinir; sayfa açılışı ve soru sayıları isimsiz toplam olarak 180 gün saklanır. Cloudflare görünmez bir bot doğrulaması yapar. Sorular cevap üretmek için yapay zekâ sağlayıcılarına (Google, Cloudflare) gönderilir; Google'ın ücretsiz katmanında hizmetin geliştirilmesinde kullanılabilir. Kişisel bilgi yazmayın.",
    eposta: "E-posta",
    ilet: "Bora'ya e-postayla sor",
    iletKonu: "Dijital ikizinden bir soru",
    hata: "Şu an cevap veremiyorum, birazdan tekrar deneyin.",
    hiz: "Çok hızlı soruyorsunuz; bir dakika sonra tekrar deneyin.",
    oturum: "Bu oturumdaki soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
    gunluk: "Bugünlük soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
    genel: "İkiz bugün çok soru aldı. Devamı için bana e-postayla yazabilirsiniz.",
    dogrulama: "Tarayıcı doğrulaması tamamlanamadı. Sayfayı yenileyip tekrar deneyin.",
  },
  en: {
    rozet: "AI twin",
    alt: "Ask me anything; my twin answers on my behalf, using only information I have approved.",
    yer: "Type a question…",
    oneriler: ["What projects have you built?", "When and where can you do your internship?", "How do you use AI in your work?"],
    bilgiDugme: "What gets saved ⓘ",
    bilgi: "This is an AI. Answers come only from information Bora has approved; if it doesn't know something, it won't make it up and will point you to Bora. Questions it can't answer are logged anonymously to improve the twin, and your answers to the twin's own questions are saved anonymously for Bora to read (no name or rest of the chat is kept). To prevent abuse, your IP address is kept only in a daily question counter and deleted by the next day at the latest; page views and question counts are stored as anonymous totals for 180 days. Cloudflare runs an invisible bot check. Questions are sent to AI providers (Google, Cloudflare) to generate answers; on Google's free tier they may be used to improve its services. Please don't include personal information.",
    eposta: "Email",
    ilet: "Ask Bora by email",
    iletKonu: "A question from your digital twin",
    hata: "I can't answer right now, please try again in a moment.",
    hiz: "You're asking a bit fast; please try again in a minute.",
    oturum: "You've reached this session's question limit. Feel free to email me to continue.",
    gunluk: "You've reached today's question limit. Feel free to email me to continue.",
    genel: "The twin has had a lot of questions today. Feel free to email me to continue.",
    dogrulama: "The browser check couldn't be completed. Please reload the page and try again.",
  },
};

const $ = (id) => document.getElementById(id);
let gecmis = []; // { rol, icerik, imza? } — ikizin cevapları sunucunun imzasıyla saklanır, aynen geri gider
let oturum = null; // sunucunun verdiği iki saatlik oturum jetonu (yalnız bellekte)
let dil = (navigator.language || "tr").toLowerCase().startsWith("tr") ? "tr" : "en";
let bekliyor = false;
let siradaki = null; // cevap beklenirken gönderilen soru kaybolmasın, cevap gelince gitsin

function diliUygula() {
  const m = METIN[dil];
  document.documentElement.lang = dil;
  document.querySelectorAll("[data-m]").forEach((el) => (el.textContent = m[el.dataset.m]));
  document.querySelectorAll("[data-dil]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dil === dil)));
  $("soru").placeholder = m.yer;
  const kutu = $("oneriler");
  if (kutu) {
    kutu.replaceChildren(...m.oneriler.map((s) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "oneri"; b.textContent = s;
      b.onclick = () => gonder(s);
      return b;
    }));
  }
}

function balon(sinif, metin) {
  const d = document.createElement("div");
  d.className = "mesaj " + sinif;
  d.textContent = metin;
  $("sohbet").append(d);
  d.scrollIntoView({ behavior: "smooth", block: "end" });
  return d;
}

// Bağlantının yeri hemen ayrılır (cevabın hemen altı): adres sonradan gelirse sıradaki sorunun altına düşmesin.
async function iletBaglantisi(soru, cevapBalonu) {
  const a = document.createElement("a");
  a.className = "ilet";
  a.hidden = true;
  cevapBalonu.after(a);
  if (!EPOSTA) await adresiAl(true); // ilk istek düştüyse bir kez daha (sayılmaz)
  if (!EPOSTA) { a.remove(); return; }
  a.textContent = METIN[dil].ilet;
  a.href = `mailto:${EPOSTA}?subject=${encodeURIComponent(METIN[dil].iletKonu)}&body=${encodeURIComponent(soru + "\n\n")}`;
  a.hidden = false;
}

// --- Bot doğrulaması: ilk soruda (ve oturum düşünce) görünmez Turnstile jetonu alınır ------------------------
let widget = null;
let bekleyen = null;

function turnstileHazir(sinirMs = 10000) {
  return new Promise((coz, ret) => {
    const bas = Date.now();
    (function bak() {
      if (window.turnstile) return coz(window.turnstile);
      if (Date.now() - bas > sinirMs) return ret(new Error("dogrulama"));
      setTimeout(bak, 100);
    })();
  });
}

// Doğrulama ne olursa olsun 30 sn'de sonuçlanır: sayfa "yazıyor"da asılı kalmasın.
function dogrulamaAl() {
  if (!TURNSTILE_SITE) return Promise.resolve(null);
  return Promise.race([dogrulamaBaslat(), new Promise((_, ret) => setTimeout(() => ret(new Error("dogrulama")), 30000))]);
}

async function dogrulamaBaslat() {
  const ts = await turnstileHazir();
  return new Promise((coz, ret) => {
    bekleyen = { coz, ret };
    if (widget === null) {
      const basarisiz = () => { bekleyen?.ret(new Error("dogrulama")); bekleyen = null; };
      widget = ts.render("#dogrulama", {
        sitekey: TURNSTILE_SITE,
        execution: "execute",
        appearance: "interaction-only",
        language: dil,
        callback: (jeton) => { bekleyen?.coz(jeton); bekleyen = null; },
        "error-callback": basarisiz,
        "timeout-callback": basarisiz,
        "expired-callback": basarisiz,
        "unsupported-callback": basarisiz,
      });
    } else {
      ts.reset(widget);
    }
    ts.execute(widget);
  });
}

async function sunucuyaSor(govde) {
  // AbortSignal.timeout eski Safari'de (iOS 15) yok: elle zamanlayıcı.
  const kesici = new AbortController();
  const zamanlayici = setTimeout(() => kesici.abort(), ZAMAN_ASIMI_MS);
  try {
    const yanit = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(govde),
      signal: kesici.signal,
    });
    return { durum: yanit.status, veri: await yanit.json().catch(() => ({})) };
  } finally {
    clearTimeout(zamanlayici);
  }
}

async function gonder(soru) {
  soru = soru.trim();
  if (!soru) return;
  if (bekliyor) { siradaki = soru; $("soru").value = ""; return; }
  $("oneriler")?.remove();
  balon("ziyaretci", soru);
  $("soru").value = "";

  if (gecmis.filter((m) => m.rol === "user").length >= OTURUM_SINIRI) {
    balon("ikiz", METIN[dil].oturum);
    return;
  }
  gecmis.push({ rol: "user", icerik: soru });

  bekliyor = true; $("gonder").disabled = true;
  const yaziyor = balon("ikiz", "");
  yaziyor.innerHTML = '<span class="yaziyor"><i></i><i></i><i></i></span>';

  try {
    const govde = () => ({ mesajlar: gecmis.slice(-8), dil, ...(oturum ? { oturum } : {}), ...(DAVET ? { davet: DAVET } : {}) });
    let y;
    if (!oturum && TURNSTILE_SITE) y = await sunucuyaSor({ ...govde(), dogrulama: await dogrulamaAl() });
    else y = await sunucuyaSor(govde());
    // Oturum süresi dolduysa bir kez yeniden doğrula; eski geçmişin imzaları eski oturuma bağlı, onu baştan bırak.
    if (y.durum === 401 && y.veri.kod === "dogrulama" && TURNSTILE_SITE) {
      oturum = null;
      gecmis = [{ rol: "user", icerik: soru }];
      y = await sunucuyaSor({ ...govde(), dogrulama: await dogrulamaAl() });
    }
    // Geçmiş doğrulanamadıysa geçmişsiz bir kez daha sor (sunucu yeni oturum açtıysa jetonu 409'da da verir).
    if (y.durum === 409) {
      if (y.veri.oturum) oturum = y.veri.oturum;
      gecmis = [{ rol: "user", icerik: soru }];
      y = await sunucuyaSor(govde());
    }
    if (y.veri.oturum) oturum = y.veri.oturum;
    if (y.durum === 429) throw new Error(y.veri.kod || "hiz");
    if (y.durum === 401) throw new Error("dogrulama");
    if (y.durum !== 200 || !y.veri.cevap) throw new Error("hata");
    yaziyor.textContent = y.veri.cevap;
    gecmis.push({ rol: "assistant", icerik: y.veri.cevap, ...(y.veri.imza ? { imza: y.veri.imza } : {}) });
    if (y.veri.iletildi) iletBaglantisi(soru, yaziyor);
  } catch (e) {
    yaziyor.textContent = METIN[dil][e.message] || METIN[dil].hata;
    yaziyor.classList.add("hata");
    gecmis.pop(); // cevapsız soru geçmişte kalmasın
    iletBaglantisi(soru, yaziyor); // ikiz cevap veremese de işveren soruyu Bora'ya iletebilsin
  } finally {
    bekliyor = false; $("gonder").disabled = false; $("soru").focus();
    $("sohbet").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
    if (siradaki) { const s = siradaki; siradaki = null; gonder(s); }
  }
}

$("form").addEventListener("submit", (e) => { e.preventDefault(); gonder($("soru").value); });
document.querySelectorAll("[data-dil]").forEach((b) => (b.onclick = () => { dil = b.dataset.dil; diliUygula(); }));
$("bilgiDugme").onclick = () => {
  const acik = $("bilgiKutu").hidden;
  $("bilgiKutu").hidden = !acik;
  $("bilgiDugme").setAttribute("aria-expanded", String(acik));
};
function adresiAl(tekrar = false) {
  // Davet kodu başlıkta gider (adreste değil): özgeçmişten gelen açılış ayrı sayılır.
  const basliklar = { ...(DAVET ? { "X-Davet": DAVET } : {}), ...(tekrar ? { "X-Tekrar": "1" } : {}) };
  return fetch(ILETISIM, { signal: AbortSignal.timeout(5000), headers: basliklar }).then((y) => (y.ok ? y.json() : null)).then((v) => {
    if (!v || typeof v.eposta !== "string" || !v.eposta.includes("@")) return;
    EPOSTA = v.eposta;
    $("eposta").href = "mailto:" + EPOSTA;
    $("eposta").hidden = false;
  }).catch(() => {});
}
adresiAl();
if (LINKEDIN) $("linkedin").href = LINKEDIN; else $("linkedin").remove();
diliUygula();
