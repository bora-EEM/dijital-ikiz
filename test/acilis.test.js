// Açılış kaydı (Bora'nın kararı 2026-10-26, "en etik yoldan"): her açılış rastgele kimlikle; yalnız dakika, ülke,
// internetin geldiği kurum, cihaz türü, dil, robot olabilir mi, süre, soru sayısı ve sorunlar. IP, tarayıcı kimliği, adres yolu
// yazılmaz; izlenmek istemeyen (GPC, DNT) yalnız sayılır; kayıt 14 günde silinir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sayacIslem, bellekDeposu } from "../worker/src/sayac.js";
import { istegiIsle } from "../worker/src/index.js";

const K = "0123456789abcdef";
const UA_TELEFON = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const env = () => ({ ILETISIM_EPOSTA: "ornek@okul.edu.tr", IZINLI_KOKENLER: "https://bora-eem.github.io", BORA_ANAHTARI: "bora",
  DAVET_ANAHTARI: "davet-kodu-ornek", GELISTIRME: "1", __depo: bellekDeposu(), HIZ_SINIRI: { limit: async () => ({ success: true }) } });
// Cloudflare'in istek üstüne koyduğu bilgi (ülke, ağın sahibi); Node'un Request'inde yok, elle eklenir.
const cfli = (istek, cf) => (cf ? Object.defineProperty(istek, "cf", { value: cf }) : istek);
const ac = (e, basliklar = {}, cf = null) => istegiIsle(cfli(new Request("http://x/api/iletisim", {
  headers: { Origin: "https://bora-eem.github.io", "CF-Connecting-IP": "203.0.113.7", "User-Agent": UA_TELEFON,
             "CF-IPCountry": "DE", "Accept-Language": "de-DE,de;q=0.9,en;q=0.8", ...basliklar } }), cf), e, null);
const olay = (e, govde, basliklar = {}) => istegiIsle(new Request("http://x/api/olay", {
  method: "POST", headers: { Origin: "https://bora-eem.github.io", "Content-Type": "text/plain;charset=UTF-8", "CF-IPCountry": "DE",
                             "User-Agent": UA_TELEFON, ...basliklar }, body: typeof govde === "string" ? govde : JSON.stringify(govde) }), e, null);
const oku = async (e) => (await (await istegiIsle(new Request("http://x/api/acilislar", { headers: { Authorization: "Bearer bora" } }), e, null)).json()).acilislar;

test("açılış kaydı: ülke, kurum, cihaz, dil ve davet yazılır; IP, tarayıcı kimliği ve gelinen site yazılmaz", async () => {
  const e = env();
  assert.equal((await ac(e, { "X-Acilis": K, "X-Kaynak": "www.linkedin.com", "X-Davet": "davet-kodu-ornek" },
    { country: "DE", asOrganization: "Ornek Muhendislik GmbH<script>" })).status, 200);
  const [a] = await oku(e);
  assert.equal(a.kimlik, K);
  assert.deepEqual({ ulke: a.ulke, kurum: a.kurum, cihaz: a.cihaz, dil: a.dil, robot: a.robot, davet: a.davet, soru: a.soru },
    { ulke: "DE", kurum: "Ornek Muhendislik GmbHscript", cihaz: "telefon", dil: "de", robot: false, davet: true, soru: 0 });
  assert.equal(a.kaynak, undefined, "gelinen site yazılmaz");
  assert.match(a.zaman, /:00\.000Z$/, "zaman dakikaya yuvarlanır");
  const ham = JSON.stringify(await oku(e));
  assert.ok(!ham.includes("203.0.113") && !ham.includes("iPhone") && !ham.includes("Mozilla"), "IP ve tarayıcı kimliği kayda girmemeli");
  // Günlük toplam da artar.
  const g = (await sayacIslem(e.__depo, e, { islem: "istatistik" })).gunler[0];
  assert.equal(g.ziyaretDavet, 1);
});

test("izlenmek istemeyen (GPC, DNT) ve kimliksiz açılış yalnız sayılır; ikinci istek ve bozuk kimlik kayıt açmaz", async () => {
  const e = env();
  await ac(e, { "X-Acilis": K, "Sec-GPC": "1" });
  await ac(e, { "X-Acilis": "1111111111111111", DNT: "1" });
  await ac(e);
  await ac(e, { "X-Acilis": "../bilgi" });
  await ac(e, { "X-Acilis": "2222222222222222", "X-Tekrar": "1" });
  assert.equal((await oku(e)).length, 0);
  assert.equal((await sayacIslem(e.__depo, e, { islem: "istatistik" })).gunler[0].ziyaret, 4);
});

test("robot işaretlenir; kurum bilinmiyorsa boş kalır", async () => {
  const e = env();
  await ac(e, { "X-Acilis": K, "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
  const [a] = await oku(e);
  assert.equal(a.kurum, "");
  assert.equal(a.robot, true);
  assert.equal(a.cihaz, "bilgisayar");
});

test("sorun kaydı: bilinen olaylar sırayla yazılır, kalma süresinin en büyüğü kalır, ilk istek düştüyse kayıt yine açılır", async () => {
  const e = env();
  // Sayfanın ilk isteği hiç gelmedi: sorun kaydı açılışı kendisi açar.
  assert.equal((await olay(e, { acilis: K, olay: "iletisim", ayrinti: "zaman" })).status, 204);
  await olay(e, { acilis: K, olay: "dogrulama", ayrinti: "hata-300030" });
  await olay(e, { acilis: K, olay: "ayrildi", sure: 95 });
  await olay(e, { acilis: K, olay: "ayrildi", sure: 12 });
  await olay(e, { acilis: K, olay: "kotu-olay", ayrinti: "x" });
  await olay(e, { acilis: K, olay: "ag", ayrinti: "<script>baglanti</script>" });
  const [a] = await oku(e);
  assert.equal(a.ulke, "DE");
  assert.equal(a.sure, 95);
  assert.deepEqual(a.olaylar.map((o) => [o.olay, o.ayrinti]), [["iletisim", "zaman"], ["dogrulama", "hata-300030"], ["ag", "scriptbaglantiscript"]]);
  for (let i = 0; i < 20; i++) await olay(e, { acilis: K, olay: "ag", ayrinti: "baglanti" });
  assert.equal((await oku(e))[0].olaylar.length, 12, "açılış başına sorun kaydı tavanlı");
});

test("sorun ucu: yabancı köken, büyük ya da bozuk gövde, izinsiz ziyaretçi yazılmaz; uç anahtarsız okunamaz", async () => {
  const e = env();
  assert.equal((await olay(e, { acilis: K, olay: "ag" }, { Origin: "https://kotu.example" })).status, 403);
  assert.equal((await olay(e, JSON.stringify({ acilis: K, olay: "ag", ayrinti: "x".repeat(2000) }))).status, 204);
  assert.equal((await olay(e, "{bozuk")).status, 204);
  assert.equal((await olay(e, { acilis: K, olay: "ag" }, { "Sec-GPC": "1" })).status, 204);
  assert.equal((await oku(e)).length, 0);
  const anahtarsiz = await istegiIsle(new Request("http://x/api/acilislar"), e, null);
  assert.equal(anahtarsiz.status, 404);
  const sinavla = await istegiIsle(new Request("http://x/api/acilislar", { headers: { Authorization: "Bearer sinav" } }), { ...e, SINAV_ANAHTARI: "sinav" }, null);
  assert.equal(sinavla.status, 404, "sınav anahtarı açılışlara açılmamalı");
});

test("soru sorulduğu açılışa yazılır; oturum da açılışını bilir", async () => {
  const e = { ...env(), BILGI_METNI: "İngilizcem B2.", GEMINI_API_KEY: "m", IMZA_SIRRI: "" };
  const gercek = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tur":"A","cevap":"İngilizcem B2."}' } }] }));
  try {
    await ac(e, { "X-Acilis": K });
    const sor = () => istegiIsle(new Request("http://x/api/sohbet", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" },
      body: JSON.stringify({ mesajlar: [{ rol: "user", icerik: "İngilizcen nasıl?" }], acilis: K }) }), e, null);
    assert.equal((await sor()).status, 200);
    assert.equal((await sor()).status, 200);
  } finally { globalThis.fetch = gercek; }
  const [a] = await oku(e);
  assert.equal(a.soru, 2);
  const { oturumlar } = await (await istegiIsle(new Request("http://x/api/oturumlar", { headers: { Authorization: "Bearer bora" } }), e, null)).json();
  assert.equal(oturumlar[0].acilis, K);
  assert.equal(a.oturum, oturumlar[0].kimlik);
});

test("14 günü geçen açılış kaydı silinir (okumada ve gün değişiminde); yenisi kalır", async () => {
  const depo = bellekDeposu();
  const eski = new Date(Date.now() - 15 * 86_400_000).toISOString();
  await depo.put("ac:aaaaaaaaaaaaaaaa", { kimlik: "aaaaaaaaaaaaaaaa", zaman: eski, olaylar: [] });
  await depo.put("ac:bbbbbbbbbbbbbbbb", { kimlik: "bbbbbbbbbbbbbbbb", zaman: new Date().toISOString(), olaylar: [] });
  await depo.put("gun", "2000-01-01");
  await sayacIslem(depo, {}, { islem: "butce" }); // gün değişimi
  assert.equal(await depo.get("ac:aaaaaaaaaaaaaaaa"), undefined);
  assert.ok(await depo.get("ac:bbbbbbbbbbbbbbbb"));
  await depo.put("ac:cccccccccccccccc", { kimlik: "cccccccccccccccc", zaman: eski, olaylar: [] });
  const { acilislar } = await sayacIslem(depo, {}, { islem: "acilislar" });
  assert.deepEqual(acilislar.map((a) => a.kimlik), ["bbbbbbbbbbbbbbbb"]);
});

test("sunucunun reddettiği doğrulama yalnız var olan açılışa yazılır, sahte kimlikle yeni kayıt açılmaz", async () => {
  const e = { ...env(), BILGI_METNI: "İngilizcem B2.", GEMINI_API_KEY: "m", TURNSTILE_SECRET: "t", IMZA_SIRRI: "sir" };
  const gercek = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }));
  const sor = (acilis) => istegiIsle(new Request("http://x/api/sohbet", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9", "User-Agent": UA_TELEFON },
    body: JSON.stringify({ mesajlar: [{ rol: "user", icerik: "Merhaba" }], dogrulama: "sahte-jeton", acilis }) }), e, null);
  try {
    assert.equal((await sor("9999999999999999")).status, 401);
    assert.equal((await oku(e)).length, 0, "bot rastgele kimlikle sahte sorun kaydı açamamalı");
    await ac(e, { "X-Acilis": K });
    assert.equal((await sor(K)).status, 401);
  } finally { globalThis.fetch = gercek; }
  const [a] = await oku(e);
  assert.deepEqual(a.olaylar.map((o) => [o.olay, o.ayrinti]), [["dogrulamaSunucu", "reddedildi"]]);
});

test("sorun ucundan açılan kayıt günlük tavanlı; sayfa açılışından gelen kayıt tavandan etkilenmez", async () => {
  const e = env();
  const hata = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 205; i++) await olay(e, { acilis: i.toString(16).padStart(16, "f"), olay: "iletisim", ayrinti: "zaman" });
  } finally { console.error = hata; }
  assert.equal((await oku(e)).length, 200);
  await ac(e, { "X-Acilis": K });
  assert.equal((await oku(e)).length, 201);
  const g = (await sayacIslem(e.__depo, e, { islem: "istatistik" })).gunler[0];
  assert.equal(g.acilisKaydiSorundan, 200);
});

test("izlenmek istemeyen ziyaretçinin sohbeti açılışa bağlanmaz", async () => {
  const e = { ...env(), BILGI_METNI: "İngilizcem B2.", GEMINI_API_KEY: "m", IMZA_SIRRI: "" };
  const gercek = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"tur":"A","cevap":"İngilizcem B2."}' } }] }));
  try {
    await ac(e, { "X-Acilis": K });
    await istegiIsle(new Request("http://x/api/sohbet", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9", "Sec-GPC": "1" },
      body: JSON.stringify({ mesajlar: [{ rol: "user", icerik: "İngilizcen nasıl?" }], acilis: K }) }), e, null);
  } finally { globalThis.fetch = gercek; }
  assert.equal((await oku(e))[0].soru, 0);
  const { oturumlar } = await (await istegiIsle(new Request("http://x/api/oturumlar", { headers: { Authorization: "Bearer bora" } }), e, null)).json();
  assert.equal(oturumlar[0].acilis, undefined);
});
