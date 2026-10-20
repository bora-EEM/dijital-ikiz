// Oturum kaydı (Bora'nın kararı 2026-10-21): soru ve cevaplar oturum oturum tutulur; IP ve kişisel bilgi girmez,
// Bora'nın bilgisayarı arşivleyip siler, alınmayan kayıt 14 günde kendiliğinden gider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kisiselBilgiyiGizle, oturumKayitKimligi } from "../worker/src/guvenlik.js";
import { sayacIslem, bellekDeposu } from "../worker/src/sayac.js";
import { istegiIsle } from "../worker/src/index.js";

test("metinde e-posta ve telefon gizlenir (yaygın Türkiye yazımları); tarih, yıl, tutar ve izinli adres kalır", () => {
  const g = (s) => kisiselBilgiyiGizle(s, ["ornek@gmail.com"]);
  assert.equal(g("Bana ik@ornek.com.tr adresinden yaz."), "Bana [e-posta] adresinden yaz.");
  assert.equal(g("Bana ornek@gmail.com adresinden ulaşabilirsiniz."), "Bana ornek@gmail.com adresinden ulaşabilirsiniz.");
  for (const tel of ["0532 123 45 67", "0 532 123 45 67", "0 (532) 123 45 67", "90 532 123 45 67", "0090 532 123 45 67",
                     "+90 (532) 123-45-67", "5321234567", "0212 123 45 67", "0532.123.45.67"]) {
    assert.equal(g(`Numaram ${tel}, ara.`), "Numaram [telefon], ara.", tel);
  }
  assert.equal(g("Tel 0532 123 45 67 (09.00-18.00)"), "Tel [telefon] (09.00-18.00)");
  assert.equal(g("0532 123 45 67 0533 765 43 21"), "[telefon] [telefon]");
  assert.equal(g("0532 1234567 2026-10-21"), "[telefon] 2026-10-21");
  assert.equal(g("2026-11-03 ile 2026-12-15 arası 30 iş günü"), "2026-11-03 ile 2026-12-15 arası 30 iş günü");
  assert.equal(g("Maaş 25.000 TL, 2027'de mezun"), "Maaş 25.000 TL, 2027'de mezun");
});

test("kayıt kimliği oturumun sırlı özeti: 16 hane, aynı oturum aynı, farklı sır farklı", async () => {
  const a = await oturumKayitKimligi("ip-203.0.113.7", "sir");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, await oturumKayitKimligi("ip-203.0.113.7", "sir"));
  assert.notEqual(a, await oturumKayitKimligi("ip-203.0.113.8", "sir"));
  assert.notEqual(a, await oturumKayitKimligi("ip-203.0.113.7", "baska"));
  assert.match(await oturumKayitKimligi("ip-203.0.113.7"), /^[0-9a-f]{16}$/); // sırsız (yerel) yol da çalışır
});

test("oturum kaydı: sorular sırayla eklenir, davet işaretlenir, karşılaştır-sil yalnız aynı hâli siler", async () => {
  const depo = bellekDeposu();
  const yaz = (v) => sayacIslem(depo, {}, { islem: "oturumYaz", kimlik: "0123456789abcdef", ...v });
  assert.equal((await yaz({ zaman: "2026-10-21T09:00:00.000Z", soru: "Hangi projeleri yaptın?", cevap: "Elektronik burun.", tur: "A", saglayici: "gemini:x" })).tamam, true);
  await yaz({ zaman: "2026-10-21T09:02:00.000Z", davet: true, soru: "Maaş?", cevapsiz: true });
  const o = (await sayacIslem(depo, {}, { islem: "oturumlar" })).oturumlar[0];
  assert.equal(o.baslangic, "2026-10-21T09:00:00.000Z");
  assert.equal(o.son, "2026-10-21T09:02:00.000Z");
  assert.equal(o.davet, true);
  assert.deepEqual(o.mesajlar.map((m) => [m.soru, m.cevap, m.tur]), [["Hangi projeleri yaptın?", "Elektronik burun.", "A"], ["Maaş?", null, null]]);
  assert.equal((await sayacIslem(depo, {}, { islem: "oturumYaz", kimlik: "../bilgi" })).tamam, false);
  await depo.put("bilgi", "yedek");
  // Arşivlendikten sonra yeni soru geldiyse (son değişti) silinmez.
  await yaz({ zaman: "2026-10-21T09:05:00.000Z", soru: "Bir soru daha", cevap: "Tamam.", tur: "A" });
  let sil = await sayacIslem(depo, {}, { islem: "oturumSil", kayitlar: [{ kimlik: "0123456789abcdef", son: "2026-10-21T09:02:00.000Z" }] });
  assert.equal(sil.silinen, 0);
  sil = await sayacIslem(depo, {}, { islem: "oturumSil", kayitlar: [{ kimlik: "0123456789abcdef", son: "2026-10-21T09:05:00.000Z" }, { kimlik: "bilgi" }, { kimlik: "../gun", son: "x" }] });
  assert.equal(sil.silinen, 1);
  assert.equal((await sayacIslem(depo, {}, { islem: "oturumlar" })).oturumlar.length, 0);
  assert.equal(await depo.get("bilgi"), "yedek");
});

test("oturum başına kayıt tavanı var, sığmayan soru 'kesik' sayılır; uzun soru ve cevap kırpılır", async () => {
  const depo = bellekDeposu();
  for (let i = 0; i < 30; i++) await sayacIslem(depo, {}, { islem: "oturumYaz", kimlik: "aaaaaaaaaaaaaaaa", soru: "s".repeat(900), cevap: "c".repeat(3000), tur: "A" });
  assert.equal((await sayacIslem(depo, {}, { islem: "oturumYaz", kimlik: "aaaaaaaaaaaaaaaa", soru: "fazla" })).tamam, false);
  const o = (await sayacIslem(depo, {}, { islem: "oturumlar" })).oturumlar[0];
  assert.equal(o.mesajlar.length, 30);
  assert.equal(o.kesik, 1);
  assert.equal(o.mesajlar[0].soru.length, 600);
  assert.equal(o.mesajlar[0].cevap.length, 2000);
});

test("14 günü geçen oturum kaydı silinir (gün değişiminde ve okumada); bilgi, gün ve istatistik kalır; 128'den fazla da silinir", async () => {
  const depo = bellekDeposu();
  const eski = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const yeni = new Date(Date.now() - 2 * 86_400_000).toISOString();
  for (let i = 0; i < 200; i++) {
    const k = i.toString(16).padStart(16, "0");
    await depo.put(`ot:${k}`, { kimlik: k, baslangic: eski, son: eski, mesajlar: [] });
  }
  await depo.put("ot:2222222222222222", { kimlik: "2222222222222222", baslangic: yeni, son: yeni, mesajlar: [] });
  const dun = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await depo.put(`ist:${dun}`, { soru: 3 });
  await depo.put("bilgi", "yedek");
  await depo.put("gun", "2000-01-01"); // gün değişmiş gibi
  const { oturumlar } = await sayacIslem(depo, {}, { islem: "oturumlar" });
  assert.deepEqual(oturumlar.map((o) => o.kimlik), ["2222222222222222"]);
  assert.equal(await depo.get("bilgi"), "yedek");
  assert.deepEqual(await depo.get(`ist:${dun}`), { soru: 3 });
  // Gün değişmeden de okumada budanır.
  await depo.put("ot:3333333333333333", { kimlik: "3333333333333333", baslangic: eski, son: eski, mesajlar: [] });
  assert.equal((await sayacIslem(depo, {}, { islem: "oturumlar" })).oturumlar.length, 1);
});

test("sohbet oturuma yazılır (soru ve cevapta kişisel bilgi gizli, IP yok), cevapsız da yazılır; sınav yazılmaz; uçlar Bora anahtarıyla", async () => {
  const depo = bellekDeposu();
  const env = { BILGI_METNI: "Elektrik-elektronik mühendisliği öğrencisiyim.", GEMINI_API_KEY: "m", SINAV_ANAHTARI: "sinav",
                BORA_ANAHTARI: "bora", IMZA_SIRRI: "", ILETISIM_EPOSTA: "a@b.c", GELISTIRME: "1", __depo: depo };
  const gercek = globalThis.fetch;
  let cevap = '{"tur":"A","cevap":"Elektrik-elektronik mühendisliği öğrencisiyim."}';
  globalThis.fetch = async () => (cevap ? new Response(JSON.stringify({ choices: [{ message: { content: cevap } }] }))
    : new Response("{}", { status: 500 }));
  const sor = (icerik, basliklar = {}) => istegiIsle(new Request("http://x/api/sohbet", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9", ...basliklar },
    body: JSON.stringify({ mesajlar: [{ rol: "user", icerik }] }),
  }), env, null);
  const gercekHata = console.error;
  console.error = () => {};
  try {
    assert.equal((await sor("Ne okuyorsun? Bana ik@firma.com ya da 0532 123 45 67 ile dön.")).status, 200);
    assert.equal((await sor("Sınav sorusu", { "X-Sinav-Anahtari": "sinav" })).status, 200);
    cevap = null;
    assert.notEqual((await sor("İkinci soru")).status, 200);
  } finally { globalThis.fetch = gercek; console.error = gercekHata; }
  const oku = (anahtar) => istegiIsle(new Request("http://x/api/oturumlar", { headers: anahtar ? { Authorization: `Bearer ${anahtar}` } : {} }), env, null);
  assert.equal((await oku()).status, 404);
  assert.equal((await oku("sinav")).status, 404, "sınav anahtarı konuşmalara açılmamalı");
  const { oturumlar } = await (await oku("bora")).json();
  assert.equal(oturumlar.length, 1);
  const [ilk, ikinci] = oturumlar[0].mesajlar;
  assert.equal(ilk.soru, "Ne okuyorsun? Bana [e-posta] ya da [telefon] ile dön.");
  assert.equal(ilk.cevap, "Elektrik-elektronik mühendisliği öğrencisiyim.");
  assert.equal(ikinci.soru, "İkinci soru");
  assert.equal(ikinci.cevap, null);
  const ham = JSON.stringify(oturumlar);
  assert.ok(!ham.includes("198.51.100") && !ham.includes("ip-"), "IP ve ham oturum kimliği kayda girmemeli");
  const sil = await istegiIsle(new Request("http://x/api/oturumlar/sil", { method: "POST", headers: { Authorization: "Bearer bora" },
    body: JSON.stringify({ kayitlar: [{ kimlik: oturumlar[0].kimlik, son: oturumlar[0].son }] }) }), env, null);
  assert.equal((await sil.json()).silinen, 1);
  assert.equal((await (await oku("bora")).json()).oturumlar.length, 0);
});
