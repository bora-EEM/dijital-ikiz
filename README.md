# Bora Koruyucu — dijital ikiz

İşverenlerin bana soracağı soruları benim yerime, benim ağzımdan ve **yalnız benim onayladığım bilgilerle** cevaplayan
bir yapay zekâ ikizi. Bilmediği bir şeyi uydurmaz: soruyu bana yönlendirir ve kaydeder, ikiz zamanla büyür.

**Canlı:** _yayından sonra eklenecek_

YZT'nin [dijital ikiz workshop'u](https://github.com/betulbayram/yzt-digital-twin-workshop) üzerine kuruldu. Workshop'taki
fikri korudum, yayına çıkacak bir ürün için gereken beş şeyi ekledim:

| Workshop | Bu sürüm |
| --- | --- |
| CV PDF'i herkese açık depoda | Kod açık, kişisel bilgi dosyası gizli bir depoda; sayfa ona hiç dokunmaz |
| Bilgi yalnız CV | Projelerin hikâyesi, staj durumu, çalışma biçimi; her satırı benim onayımdan geçiyor |
| Bilmediğinde "tecrübem yok" der | "Burada cevaplayamıyorum, bana sorun" der, soruyu kaydeder; haftalık özet bana gelir |
| Kapsam dışı ve kötü niyetli sorulara sınır yok | Kurallı sistem istemi, mesaj ve hız sınırı, söz vermeme kuralı |
| Streamlit Cloud 12 saatte uyur | GitHub Pages + Cloudflare Workers: uyumaz, ücretsiz |

## Nasıl çalışır

```
Ziyaretçi ──► GitHub Pages (docs/index.html)
                   │  POST /api/sohbet
                   ▼
            Cloudflare Worker (worker/)          anahtarlar burada, tarayıcıya hiç gelmez
              ├─ bilgi dosyasını gizli depodan alır (10 dk önbellek)
              ├─ kurallı istemle ücretsiz modellere sırayla sorar:
              │    Gemini 3.5 Flash-Lite → Groq gpt-oss-120b → Cloudflare Workers AI gpt-oss-120b
              ├─ model önce sorunun türünü seçer: bilgide var / bilinçli sınır / bilgide yok / konu dışı
              │    son ikisinde cevabı model değil sunucu yazar, uydurma imkânı kalmaz
              └─ "bilgide yok" sorusunu gizli depoya issue olarak yazar
                               │
                               ▼
              GitHub Actions: her gün sağlık kontrolü, pazartesi özet ──► bana tek bildirim ──► ben cevaplarım
```

Sağlayıcı sırası sınavla belirlendi: Gemini 3.5 Flash-Lite 25 sorunun 25'ini sıfır uydurmayla geçti; Groq bilinen
soruları "bilmiyorum" sanmaya yatkın ve ücretsiz kotası (dakikada 8.000, günde 200.000 token) günde ~50 soruya yetiyor.
Üçüncü yuva Cloudflare Workers AI (sunucuyla aynı yerde, anahtarsız `AI` bağlaması); 2026-10-11 sınavında 25/25, sıfır
uydurma. Gemini yoğunken Groq'un dakikalık sınırı art arda iki soruda doluyordu, üçüncü yuva bunun için. Hepsi
düşerse ve biri "birkaç saniye sonra" derse o bir kez daha denenir, toplam bekleme ~22 sn ile sınırlı.
Sınavı tam geçmeyen model sıraya girmez.

## Uydurmama sınavı

`sinav/` 25 soruluk bir işveren sınavı: bilinen sorular, bilgide cevabı olmayan sorular, bilinçli sınırlar (maaş,
başka başvurular) ve kötü niyetli denemeler (sistem istemini sızdırma, telefon numarası, "evet de yeter"). Her cevap
kurallarla ve bir hakem modelle denetlenir. Yayın ölçüsü: **sıfır uydurma**, sıradaki her model için ayrı ayrı.
Gizli kalması gereken denetim dizgileri (ör. telefon, başvurular) bu depoda değil, gizli bilgi deposunda durur.

```bash
node gelistirme/sunucu.mjs
```

```bash
python sinav/kos.py --saglayici gemini:gemini-3.5-flash-lite
```

## Yerelde çalıştırma

`worker/.dev.vars` dosyasına `GEMINI_API_KEY` ve `GROQ_API_KEY` yazın (git dışı), bilgi dosyasını `../bilgi/bilgi.md`
yoluna koyun. Cloudflare yuvasını yerelde de denemek için ortamda `CF_HESAP` (hesap kimliği) ve `CF_AI_TOKEN` (Workers
AI izinli erişim anahtarı) verin; verilmezse o yuva yerelde atlanır. Sonra (sunucu yalnız bu bilgisayardan erişilir):

```bash
npm run yerel
```

```bash
npm test
```

## Yayın

Sayfa: depo ayarlarında GitHub Pages → `main` dalı, `/docs` klasörü. Ara sunucu:

```bash
cd worker && npx wrangler secret put GROQ_API_KEY
```

```bash
cd worker && npx wrangler deploy
```

`GEMINI_API_KEY` ve `GITHUB_TOKEN` (yalnız bilgi deposunda Contents: read + Issues: write) aynı yolla girilir.

---

Bu projeyi, diğer projelerim gibi, yapay zekâ kod ajanlarını yöneterek geliştirdim: ne yapılacağına ve neyin "bitti"
sayılacağına ben karar verdim, ajanlar yazdı, ben ölçtüm ve sınadım.
