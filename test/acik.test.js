// Açık taramasının (2026-10-19) bulduklarına karşı: kısmen bilinen soru (K), teknik bilgi sorusu (T), metin olmayan
// cevap, görüşme sonu sorusundan sonra C, süre bütçesi, bilgi dosyası denetimi, sağlık ucu ve sınav isteğinin kaydı.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cevabiCoz, hazirCevap, bilgiGecerliMi, bilgiyiAl, cevapla, SORU_EKI, soruSoruldu } from "../worker/src/ikiz.js";
import { istegiIsle } from "../worker/src/index.js";

function sahteFetch(cevaplar, once = () => {}) {
  const giden = [];
  const gercek = globalThis.fetch;
  globalThis.fetch = async (url, secenek = {}) => {
    giden.push({ url: String(url), govde: secenek.body ? JSON.parse(secenek.body) : null });
    once(giden.length);
    const c = cevaplar.shift();
    if (!c) throw new Error("beklenmeyen çağrı: " + url);
    return new Response(typeof c.govde === "string" ? c.govde : JSON.stringify(c.govde), { status: c.durum ?? 200 });
  };
  return { giden, geriAl: () => { globalThis.fetch = gercek; } };
}
const modelCevabi = (icerik) => ({ govde: { choices: [{ message: { content: icerik } }] } });
const istek = (mesajlar, basliklar = {}) => new Request("http://x/api/sohbet", {
  method: "POST", headers: { "Content-Type": "application/json", ...basliklar }, body: JSON.stringify({ mesajlar }),
});
const GECERLI_BILGI = "# Bilgi\n\n## Kimim\n\n" + "Elektrik-elektronik mühendisliği öğrencisiyim. ".repeat(60);

test("K: bilinen kısım gider, eksik kısım için sunucunun cümlesi eklenir ve soru iletilir; boş K bilinmeyen sayılır", () => {
  const k = cevabiCoz('{"tur":"K","cevap":"Keras ve TensorFlow kullandım."}', "tr", "a@b.c");
  assert.equal(k.gecerli, true);
  assert.equal(k.tur, "K");
  assert.equal(k.iletildi, true);
  assert.equal(k.cevap, "Keras ve TensorFlow kullandım.");
  assert.match(hazirCevap("K-eki", "tr", "a@b.c"), /^Gerisini burada cevaplayamıyorum; bana a@b\.c/);
  assert.match(hazirCevap("K-eki", "en", "a@b.c"), /^I can't answer the rest here/);
  const bos = cevabiCoz('{"tur":"K","cevap":""}', "tr", "a@b.c");
  assert.equal(bos.tur, "C");
  assert.equal(bos.iletildi, true);
  assert.equal(bos.cevap, hazirCevap("C", "tr", "a@b.c"));
});

test("K cevabı bekçiden geçer, eki sonda; T türü görüşmeye çağırır, iletilmez; model metni ziyaretçiye gitmez", async () => {
  const f = sahteFetch([modelCevabi('{"tur":"K","cevap":"Keras ve TensorFlow kullandım."}')]);
  try {
    const s = await cevapla([{ role: "user", content: "PyTorch biliyor musun?" }], { BILGI_METNI: "Keras ve TensorFlow", GEMINI_API_KEY: "m", ILETISIM_EPOSTA: "a@b.c" });
    assert.equal(s.tur, "K");
    assert.equal(s.iletildi, true);
    assert.equal(s.cevap, `Keras ve TensorFlow kullandım.\n\n${hazirCevap("K-eki", "tr", "a@b.c")}`);
  } finally { f.geriAl(); }
  const t = cevabiCoz('{"tur":"T","cevap":"τ = RC"}', "tr", "a@b.c");
  assert.equal(t.iletildi, false);
  assert.equal(t.cevap, hazirCevap("T", "tr", "a@b.c"));
  assert.doesNotMatch(t.cevap, /RC/);
  assert.match(hazirCevap("T", "tr", "a@b.c"), /görüşmede/);
});

test("cevap metin değilse geçersiz: ziyaretçiye [object Object] gitmez", () => {
  assert.equal(cevabiCoz('{"tur":"A","cevap":{"metin":"x"}}', "tr", "x").gecerli, false);
  assert.equal(cevabiCoz('{"tur":"A","cevap":["a","b"]}', "tr", "x").gecerli, false);
  assert.equal(cevabiCoz('{"tur":"A","cevap":"x"}', "tr", "x").gecerli, true);
});

test("görüşme sonu sorusundan sonra model C ya da T dese de işverenin cevabı Y olur; geçmiş modele S diye gider", async () => {
  const sorular = `Hangi işe katkı vermemi beklersiniz?\n\n${SORU_EKI.tr}`;
  assert.ok(soruSoruldu(sorular));
  for (const tur of ["C", "T"]) {
    const f = sahteFetch([modelCevabi(`{"tur":"${tur}","cevap":""}`)]);
    try {
      const s = await cevapla([
        { role: "user", content: "Bize sormak istediğin bir şey var mı?" },
        { role: "assistant", content: sorular },
        { role: "user", content: "Biz Kubernetes ve Python kullanıyoruz." },
      ], { BILGI_METNI: "x", GEMINI_API_KEY: "m", ILETISIM_EPOSTA: "a@b.c" });
      assert.equal(s.tur, "Y");
      assert.equal(s.isverenCevabi, true);
      assert.equal(s.iletildi, false);
      assert.equal(JSON.parse(f.giden[0].govde.messages[2].content).tur, "S");
    } finally { f.geriAl(); }
  }
});

test("süre bütçesi her yuvadan önce denetlenir: bütçe dolunca sıradaki yuva çağrılmaz", async () => {
  const gercekNow = Date.now;
  let kayma = 0;
  Date.now = () => gercekNow() + kayma;
  // İlk yuva cevap vermeden bütçenin neredeyse tamamını yer.
  const f = sahteFetch([{ durum: 503, govde: "yoğun" }], (n) => { if (n === 1) kayma = 21_500; });
  try {
    const s = await cevapla([{ role: "user", content: "İngilizce seviyen?" }],
      { BILGI_METNI: "x", GEMINI_API_KEY: "m", AI: { run: async () => { throw new Error("çağrılmamalı"); } }, ILETISIM_EPOSTA: "a@b.c" });
    assert.equal(s.durum, 503);
    assert.equal(f.giden.length, 1);
    assert.ok(s.denemeler.some((d) => d.neden === "süre bütçesi doldu"));
  } finally { f.geriAl(); Date.now = gercekNow; }
});

test("bilgi dosyası denetimi: boş ya da yarım dosya geçersiz", () => {
  assert.equal(bilgiGecerliMi(""), false);
  assert.equal(bilgiGecerliMi("## Kimim\nkısa"), false);
  assert.equal(bilgiGecerliMi("x".repeat(3000)), false);
  assert.equal(bilgiGecerliMi(GECERLI_BILGI), true);
});

test("bozuk dosya eski kopyanın yerine geçmez; sağlık ucu GitHub'a ulaşamayınca eski kopya olsa da 503 döner", async () => {
  const env = { GITHUB_TOKEN: "t", BILGI_DEPO: "a/b" };
  const hatalar = [];
  const gercekHata = console.error;
  console.error = (m) => hatalar.push(String(m));
  const f = sahteFetch([
    { govde: GECERLI_BILGI },                // ilk çekim: iyi kopya önbelleğe girer
    { govde: "" },                           // taze çekimde boş dosya: geçersiz, sağlık 503
    { durum: 401, govde: "Bad credentials" }, // taze çekimde anahtar bozuk: sağlık 503
  ]);
  const gercekNow = Date.now;
  let kayma = 0;
  Date.now = () => gercekNow() + kayma;
  try {
    assert.equal(await bilgiyiAl(env), GECERLI_BILGI);
    const saglik = () => istegiIsle(new Request("http://x/saglik"), { ...env, ILETISIM_EPOSTA: "a@b.c" });
    // Bir dakikadan taze GitHub kopyası varken sağlık ucu GitHub'a yeniden gitmez (herkese açık uç, GitHub sınırı).
    assert.equal((await saglik()).status, 200);
    assert.equal(f.giden.length, 1);
    kayma = 61_000;
    assert.equal((await saglik()).status, 503);
    assert.equal((await saglik()).status, 503);
    assert.equal(f.giden.length, 3);
    assert.equal(await bilgiyiAl(env), GECERLI_BILGI, "ziyaretçi yine iyi kopyayla konuşur");
    assert.ok(hatalar.some((h) => /geçersiz/.test(h)));
    assert.ok(hatalar.some((h) => /HTTP 401/.test(h)));
  } finally { f.geriAl(); console.error = gercekHata; Date.now = gercekNow; }
});

test("görüşme sonu sorularından sonra gelen gerçek yeni soru C kalır ve iletilir", async () => {
  const sorular = `Hangi işe katkı vermemi beklersiniz?\n\n${SORU_EKI.tr}`;
  const f = sahteFetch([modelCevabi('{"tur":"C","cevap":""}')]);
  try {
    const s = await cevapla([
      { role: "user", content: "Bize sormak istediğin bir şey var mı?" },
      { role: "assistant", content: sorular },
      { role: "user", content: "Docker biliyor musun?" },
    ], { BILGI_METNI: "x", GEMINI_API_KEY: "m", ILETISIM_EPOSTA: "a@b.c" });
    assert.equal(s.tur, "C");
    assert.equal(s.iletildi, true);
    assert.equal(s.isverenCevabi, undefined);
  } finally { f.geriAl(); }
});

test("bekçi K cevabını durdurursa bilinmeyen kısım yine kayda düşer (C)", async () => {
  const f = sahteFetch([modelCevabi('{"tur":"K","cevap":"PyTorch\'u 2 yıl kullandım."}')]);
  const gercekHata = console.error;
  console.error = () => {};
  try {
    const s = await cevapla([{ role: "user", content: "PyTorch biliyor musun?" }], { BILGI_METNI: "Keras ve TensorFlow", GEMINI_API_KEY: "m", ILETISIM_EPOSTA: "a@b.c" });
    assert.ok(s.bekci, "bekçi durdurmalı");
    assert.equal(s.tur, "C");
    assert.equal(s.iletildi, true);
    assert.equal(s.cevap, hazirCevap("C", "tr", "a@b.c"));
  } finally { f.geriAl(); console.error = gercekHata; }
});

test("sınav isteğinin bilinmeyen sorusu kayıt açmaz; zorlanan yuva harcama tavanını aşmaz", async () => {
  const env = { BILGI_METNI: "x", GEMINI_API_KEY: "m", GITHUB_TOKEN: "t", BILGI_DEPO: "a/b", SINAV_ANAHTARI: "sinav", ILETISIM_EPOSTA: "a@b.c" };
  const f = sahteFetch([modelCevabi('{"tur":"C","cevap":""}')]);
  try {
    const govde = await (await istegiIsle(istek([{ rol: "user", icerik: "Askerlik durumun nedir?" }], { "X-Sinav-Anahtari": "sinav" }), env, null)).json();
    assert.equal(govde.iletildi, true);
    assert.equal(f.giden.length, 1, "GitHub'a kayıt isteği gitmemeli");
  } finally { f.geriAl(); }
  // Bütçe doluyken (tavan 0) sınav anahtarıyla paralı yuva zorlansa da paralı modele istek gitmez.
  const g = sahteFetch([]);
  try {
    const yanit = await istegiIsle(istek([{ rol: "user", icerik: "İngilizce seviyen?" }],
      { "X-Sinav-Anahtari": "sinav", "X-Yalniz-Saglayici": "gemini-ucretli:gemini-3.8-flash" }),
      { ...env, GEMINI_UCRETLI_API_KEY: "p", GEMINI_UCRETLI_MODELLER: "gemini-3.8-flash", GUNLUK_BUTCE_USD: "0" }, null);
    assert.equal(yanit.status, 503);
    assert.equal(g.giden.length, 0, "paralı modele istek gitmemeli");
  } finally { g.geriAl(); }
});
