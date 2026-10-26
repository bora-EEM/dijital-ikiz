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
// Açılış kaydı (Bora'nın kararı 2026-10-26): bu açılışa rastgele bir kimlik, yalnız bu sayfanın belleğinde (çerez ve
// tarayıcı deposu yok; iki ziyaret birbirine bağlanamaz). Ziyaretçi tarayıcısında "izlenmek istemiyorum" dediyse (GPC,
// DNT) kimlik hiç üretilmez: açılış yalnız sayılır.
const IZLEME_YOK = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1" || window.doNotTrack === "1";
const ACILIS = IZLEME_YOK || !window.crypto?.getRandomValues ? ""
  : [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const OLAY = API.replace(/sohbet$/, "olay");
// Kalma süresi yalnız sayfanın görünür olduğu süre (arka planda bekleyen sekme sayılmaz).
let gorunurSure = 0, gorunurBas = document.visibilityState === "visible" ? Date.now() : null;
// Sayfada yaşanan sorunu (bot doğrulaması yüklenmedi, sunucuya ulaşılamadı) ve kalma süresini açılışa yazar. Cevap
// beklenmez; düşerse ziyaretçi hiçbir şey görmez.
function olay(ad, ek = {}) {
  if (!ACILIS) return;
  const govde = JSON.stringify({ acilis: ACILIS, olay: ad, ...(DAVET ? { davet: DAVET } : {}), ...ek });
  try { if (navigator.sendBeacon && navigator.sendBeacon(OLAY, govde)) return; } catch {}
  fetch(OLAY, { method: "POST", body: govde, keepalive: true }).catch(() => {});
}
const dogrulamaHatasi = (ayrinti) => Object.assign(new Error("dogrulama"), { ayrinti });
let EPOSTA = "";
const LINKEDIN = "https://www.linkedin.com/in/bora-koruyucu-558a09260/";
// Görünmez bot doğrulaması (Cloudflare Turnstile); site anahtarı herkese açıktır. Yerelde sunucu doğrulama istemez.
const TURNSTILE_SITE = YEREL ? "" : "0x4AAAAAAFVCNnDn_94RaIB7";
const OTURUM_SINIRI = 20;
const ZAMAN_ASIMI_MS = 35000;

const METIN = {
  tr: {
    rozet: "Dijital ikiz",
    alt: "Bana ne sormak isterseniz sorun; ikizim benim yerime, benim onayladığım bilgilerle cevaplar.",
    yer: "Bir soru yazın…",
    oneriler: ["Hangi projeleri yaptın?", "Ne zaman ve nerede staj yapabilirsin?", "Yapay zekâyı işinde nasıl kullanıyorsun?"],
    bilgiDugme: "Neler kaydedilir ⓘ",
    bilgi: "Dijital ikizi geliştirmek için sohbetler ve isimsiz ziyaret bilgileri kaydedilir.",
    eposta: "E-posta",
    ilet: "Bora'ya e-postayla sor",
    iletKonu: "Dijital ikizinden bir soru",
    kopyala: "Adresi kopyala",
    kopyalandi: "Kopyalandı",
    kopyalanamadi: "Kopyalanamadı; adres seçili, Ctrl+C ile kopyalayın",
    gmail: "Gmail'de yaz",
    hata: "Şu an cevap veremiyorum, birazdan tekrar deneyin.",
    hiz: "Çok hızlı soruyorsunuz; bir dakika sonra tekrar deneyin.",
    oturum: "Bu oturumdaki soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
    gunluk: "Bugünlük soru sınırına geldiniz. Devamı için bana e-postayla yazabilirsiniz.",
    genel: "İkiz bugün çok soru aldı. Devamı için bana e-postayla yazabilirsiniz.",
    dogrulama: "Tarayıcı doğrulaması tamamlanamadı. Sayfayı yenileyip tekrar deneyin.",
  },
  en: {
    rozet: "Digital twin",
    alt: "Ask me anything; my twin answers on my behalf, using only information I have approved.",
    yer: "Type a question…",
    oneriler: ["What projects have you built?", "When and where can you do your internship?", "How do you use AI in your work?"],
    bilgiDugme: "What gets saved ⓘ",
    bilgi: "Conversations and anonymous visit details are saved to improve the digital twin.",
    eposta: "Email",
    ilet: "Ask Bora by email",
    iletKonu: "A question from your digital twin",
    kopyala: "Copy address",
    kopyalandi: "Copied",
    kopyalanamadi: "Couldn't copy; the address is selected, press Ctrl+C",
    gmail: "Write in Gmail",
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

// Yalnız mailto bağlantısı, bilgisayarında e-posta programı kurulu olmayanlarda (Gmail'i tarayıcıda kullananlar)
// basınca hiçbir şey yapmıyordu (Bora, 2026-10-21). Artık düğme bir kutu açar: adres, kopyala ve Gmail'de yaz;
// mailto seçeneği de Bora'da çalışmadığı için kaldırıldı.
function epostaKutusu(soru) {
  const kutu = document.createElement("div");
  kutu.className = "eposta-kutu";
  const adres = document.createElement("span");
  adres.className = "adres";
  adres.textContent = EPOSTA;
  const kopya = document.createElement("button");
  kopya.type = "button";
  kopya.dataset.m = "kopyala";
  kopya.textContent = METIN[dil].kopyala;
  let zaman = null;
  kopya.onclick = async () => {
    let oldu = false;
    try { await navigator.clipboard.writeText(EPOSTA); oldu = true; }
    catch {
      // Pano izni yoksa adres seçilir ve eski yolla kopyalanır; o da olmazsa seçili kalır, ziyaretçiye söylenir.
      const secim = getSelection(); const aralik = document.createRange();
      aralik.selectNodeContents(adres); secim.removeAllRanges(); secim.addRange(aralik);
      try { oldu = document.execCommand("copy"); } catch { oldu = false; }
    }
    kopya.textContent = METIN[dil][oldu ? "kopyalandi" : "kopyalanamadi"];
    clearTimeout(zaman);
    zaman = setTimeout(() => (kopya.textContent = METIN[dil].kopyala), oldu ? 1500 : 4000);
  };
  const konu = encodeURIComponent(METIN[dil].iletKonu);
  const govde = encodeURIComponent(soru ? soru + "\n\n" : "");
  const alici = encodeURIComponent(EPOSTA).replace("%40", "@");
  const gmail = document.createElement("a");
  gmail.href = `https://mail.google.com/mail/?view=cm&fs=1&to=${alici}&su=${konu}&body=${govde}`;
  gmail.target = "_blank"; gmail.rel = "noopener";
  gmail.dataset.m = "gmail";
  gmail.textContent = METIN[dil].gmail;
  kutu.append(adres, kopya, gmail);
  return kutu;
}

// Basınca kutuyu açar, yeniden basınca kapatır. Kutu `yer`in hemen arkasına girer; durum düğmenin kendisine yazılır.
function kutuyuAcKapa(dugme, soru, yer = dugme) {
  const acik = yer.nextElementSibling;
  if (acik && acik.classList.contains("eposta-kutu")) { acik.remove(); dugme.setAttribute("aria-expanded", "false"); return; }
  yer.after(epostaKutusu(soru));
  dugme.setAttribute("aria-expanded", "true");
}

// Düğmenin yeri hemen ayrılır (cevabın hemen altı): adres sonradan gelirse sıradaki sorunun altına düşmesin.
async function iletBaglantisi(soru, cevapBalonu) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ilet";
  b.hidden = true;
  cevapBalonu.after(b);
  if (!EPOSTA) await adresiAl(true); // ilk istek düştüyse bir kez daha (sayılmaz)
  if (!EPOSTA) { b.remove(); return; }
  b.dataset.m = "ilet";
  b.textContent = METIN[dil].ilet;
  b.setAttribute("aria-expanded", "false");
  b.onclick = () => kutuyuAcKapa(b, soru);
  b.hidden = false;
}

// --- Bot doğrulaması: ilk soruda (ve oturum düşünce) görünmez Turnstile jetonu alınır ------------------------
let widget = null;
let bekleyen = null;

function turnstileHazir(sinirMs = 10000) {
  return new Promise((coz, ret) => {
    const bas = Date.now();
    (function bak() {
      if (window.turnstile) return coz(window.turnstile);
      if (Date.now() - bas > sinirMs) return ret(dogrulamaHatasi("yuklenmedi"));
      setTimeout(bak, 100);
    })();
  });
}

// Doğrulama ne olursa olsun 30 sn'de sonuçlanır: sayfa "yazıyor"da asılı kalmasın.
function dogrulamaAl() {
  if (!TURNSTILE_SITE) return Promise.resolve(null);
  return Promise.race([dogrulamaBaslat(), new Promise((_, ret) => setTimeout(() => ret(dogrulamaHatasi("zaman")), 30000))]);
}

async function dogrulamaBaslat() {
  const ts = await turnstileHazir();
  return new Promise((coz, ret) => {
    bekleyen = { coz, ret };
    if (widget === null) {
      // Turnstile hata kodunu verir (ör. 110200 alan adı, 300xxx tarayıcı); sorun kaydına kod olarak gider.
      const basarisiz = (neden) => (kod) => { bekleyen?.ret(dogrulamaHatasi(kod ? `${neden}-${kod}` : neden)); bekleyen = null; };
      widget = ts.render("#dogrulama", {
        sitekey: TURNSTILE_SITE,
        execution: "execute",
        appearance: "interaction-only",
        language: dil,
        callback: (jeton) => { bekleyen?.coz(jeton); bekleyen = null; },
        "error-callback": basarisiz("hata"),
        "timeout-callback": basarisiz("zaman"),
        "expired-callback": basarisiz("sure"),
        "unsupported-callback": basarisiz("desteklenmiyor"),
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
    const govde = () => ({ mesajlar: gecmis.slice(-8), dil, ...(oturum ? { oturum } : {}), ...(DAVET ? { davet: DAVET } : {}),
      ...(ACILIS ? { acilis: ACILIS } : {}) });
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
    if (y.durum !== 200 || !y.veri.cevap) throw Object.assign(new Error("hata"), { durum: y.durum });
    yaziyor.textContent = y.veri.cevap;
    gecmis.push({ rol: "assistant", icerik: y.veri.cevap, ...(y.veri.imza ? { imza: y.veri.imza } : {}) });
    if (y.veri.iletildi) iletBaglantisi(soru, yaziyor);
  } catch (e) {
    // Sorun açılışa yazılır: ziyaretçi neden cevap alamadı (sınır sunucuda zaten sayılıyor, yine de sırası görünsün).
    // Sunucunun reddettiği doğrulamayı sunucu kendisi yazar; burada yalnız tarayıcıda kalan doğrulama sorunu.
    if (e.message === "dogrulama") { if (e.ayrinti) olay("dogrulama", { ayrinti: e.ayrinti }); }
    else if (e.message === "hata") olay("sunucu", { ayrinti: String(e.durum || "") });
    else if (METIN.tr[e.message]) olay("sinir", { ayrinti: e.message });
    else if (e.name === "AbortError") olay("ag", { ayrinti: "zaman" });
    else if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) olay("ag", { ayrinti: "baglanti" });
    else olay("sunucu", { ayrinti: "istemci" }); // sayfanın kendi hatası, ağ değil
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
  const basliklar = { ...(DAVET ? { "X-Davet": DAVET } : {}), ...(tekrar ? { "X-Tekrar": "1" } : {}),
    ...(ACILIS ? { "X-Acilis": ACILIS } : {}) };
  return fetch(ILETISIM, { signal: AbortSignal.timeout(5000), headers: basliklar }).then((y) => {
    if (!y.ok && !tekrar) olay("iletisim", { ayrinti: String(y.status) });
    return y.ok ? y.json() : null;
  }).then((v) => {
    if (!v || typeof v.eposta !== "string" || !v.eposta.includes("@")) return;
    EPOSTA = v.eposta;
    $("eposta").href = "#";
    $("eposta").hidden = false;
    $("eposta").setAttribute("role", "button");
    $("eposta").setAttribute("aria-expanded", "false");
    $("eposta").onclick = (e) => { e.preventDefault(); kutuyuAcKapa($("eposta"), "", $("eposta").closest(".not")); };
  }).catch((e) => { if (!tekrar) olay("iletisim", { ayrinti: e.name === "TimeoutError" ? "zaman" : "baglanti" }); });
}
adresiAl();
// Kalma süresi: sekme her gizlendiğinde (kapanınca, başka sekmeye geçince) o ana kadarki görünür süre, saniye.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { gorunurBas = Date.now(); return; }
  if (gorunurBas !== null) { gorunurSure += Date.now() - gorunurBas; gorunurBas = null; }
  olay("ayrildi", { sure: Math.round(gorunurSure / 1000) });
});
if (LINKEDIN) $("linkedin").href = LINKEDIN; else $("linkedin").remove();
diliUygula();
