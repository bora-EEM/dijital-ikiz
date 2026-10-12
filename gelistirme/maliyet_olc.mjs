// Tipik bir İK sohbetini (15 soru, geçmişiyle) tek sağlayıcıya sorar; her sorunun girdi/çıktı/düşünme token'ını
// sağlayıcının kendi "usage" alanından okur. Maliyet hesabının ölçüm tarafı; cevaplar bilgi dosyasını gözden geçirmek
// için de yazılır. Anahtarlar worker/.dev.vars'tan, bilgi ../bilgi/bilgi.md'den; hiçbiri ekrana yazılmaz.
//   node gelistirme/maliyet_olc.mjs [gemini|groq] > sonuc.json
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sistemIstemi, saglayicilar, cevabiCoz } from "../worker/src/ikiz.js";

const KOK = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {};
const vars = join(KOK, "worker", ".dev.vars");
if (existsSync(vars)) for (const satir of readFileSync(vars, "utf8").split(/\r?\n/)) {
  const m = satir.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const bilgi = readFileSync(join(KOK, "..", "bilgi", "bilgi.md"), "utf8");
const secim = process.argv[2] || "gemini";
const s = saglayicilar(env).find((x) => x.ad.startsWith(secim));
if (!s) throw new Error(`sağlayıcı yok: ${secim}`);

const SORULAR = [
  "Merhaba, kendinden kısaca bahseder misin?",
  "Hangi bölümdesin, mezun oldun mu?",
  "Neden yapay zekâ alanını seçtin?",
  "En çok gurur duyduğun projen hangisi, ne başardın?",
  "Bunu nasıl ölçtün?",
  "Takım çalışması deneyimin var mı?",
  "Daha önce staj yaptın mı, orada ne yaptın?",
  "Hangi programlama dillerini ve araçları biliyorsun?",
  "Yapay zekâyı işinde nasıl kullanıyorsun?",
  "Zayıf yönün nedir?",
  "Neden bizim şirkette staj yapmak istiyorsun?",
  "Stajdan beklentin ne, bize ne katabilirsin?",
  "Ne zaman başlayabilirsin, şehir dışına gelebilir misin?",
  "5 yıl sonra kendini nerede görüyorsun?",
  "Bize sormak istediğin bir şey var mı?",
];

const sistem = { role: "system", content: `${sistemIstemi(bilgi, "koruyucubora@gmail.com")}\n\nCEVAP DİLİ: Ziyaretçinin son mesajı Türkçe. "cevap" tamamen Türkçe olsun.` };
const gecmis = [];
const satirlar = [];
for (const soru of SORULAR) {
  gecmis.push({ role: "user", content: soru });
  // Canlıdaki gibi: geçmişteki cevaplar JSON biçiminde (cevapla() ile aynı dönüşüm).
  const mesajlar = [sistem, ...gecmis.slice(-8).map((m) => (m.role === "assistant" ? { ...m, content: JSON.stringify({ tur: "A", cevap: m.content }) } : m))];
  const yanit = await fetch(s.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.anahtar}`, "Content-Type": "application/json", "User-Agent": "dijital-ikiz" },
    body: JSON.stringify({ model: s.model, messages: mesajlar, temperature: 0.1, max_tokens: 700,
      response_format: { type: "json_object" }, ...s.ek }),
  });
  const veri = await yanit.json();
  const u = veri.usage || {};
  const metin = veri.choices?.[0]?.message?.content || "";
  const c = cevabiCoz(metin, "tr", "koruyucubora@gmail.com");
  const cevap = c.gecerli ? c.cevap : `(geçersiz: ${c.neden || yanit.status})`;
  gecmis.push({ role: "assistant", content: cevap });
  satirlar.push({
    soru, tur: c.tur, cevap, ham: c.gecerli ? undefined : metin.slice(0, 300),
    bitis: veri.choices?.[0]?.finish_reason, girdi: u.prompt_tokens, cikti: u.completion_tokens,
    dusunme: u.completion_tokens_details?.reasoning_tokens ?? null,
    onbellek: u.prompt_tokens_details?.cached_tokens ?? null,
  });
  await new Promise((r) => setTimeout(r, secim === "groq" ? 20000 : 5000));
}
console.log(JSON.stringify({ saglayici: s.ad, sistemKarakter: sistem.content.length, satirlar }, null, 2));
