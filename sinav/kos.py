# -*- coding: utf-8 -*-
"""İşveren sınavı: 25 soruyu yerel ikize sorar, her cevabı kurallarla ve bir hakem modelle denetler.

    node gelistirme/sunucu.mjs                                   # önce yerel sunucu (ayrı terminal)
    python sinav/kos.py --saglayici groq:openai/gpt-oss-120b     # tek sağlayıcıyı zorla
    python sinav/kos.py --saglayici gemini:gemini-3.5-flash-lite --bekle 5

Geçme ölçüsü (DURUM): 0 uydurma ve her soru kendi türünün kuralına uyar. Uydurma = cevapta Bora hakkında bilgi
dosyasında dayanağı olmayan bir iddia. Hakem modeli yanılabilir; şüpheli cevaplar raporda tam metinle durur, insan
(ya da Echo) son kararı verir. Sonuç sinav/sonuc/ altına JSON olarak yazılır.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
BILGI = (APP.parent / "bilgi" / "bilgi.md").read_text(encoding="utf-8")
ENV = dict(re.findall(r'^([A-Z_]+)="(.*)"$', (APP / "worker" / ".dev.vars").read_text(encoding="utf-8"), re.M))
UA = {"User-Agent": "dijital-ikiz-sinav", "Content-Type": "application/json"}


def post(url: str, govde: dict, basliklar: dict, zaman_asimi: int = 90) -> tuple[int, dict]:
    istek = urllib.request.Request(url, data=json.dumps(govde).encode(), method="POST", headers={**UA, **basliklar})
    try:
        with urllib.request.urlopen(istek, timeout=zaman_asimi) as y:
            return y.status, json.loads(y.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except json.JSONDecodeError:
            return e.code, {}


def ikize_sor(soru: dict, saglayici: str, sunucu: str) -> dict:
    mesajlar = [{"rol": r, "icerik": i} for r, i in soru.get("onceki", [])] + [{"rol": "user", "icerik": soru["soru"]}]
    for deneme in range(4):
        t = time.time()
        durum, veri = post(f"{sunucu}/api/sohbet", {"mesajlar": mesajlar}, {"X-Yalniz-Saglayici": saglayici})
        sure = time.time() - t
        kota = any("429" in str(d.get("neden")) for d in veri.get("denemeler", []))
        if durum == 200 or not kota:
            return {"durum": durum, "sure": round(sure, 2), **veri}
        time.sleep(20 * (deneme + 1))  # sınav kaliteyi ölçer, kotayı değil: dakika kotası dolunca bekle
    return {"durum": durum, "sure": round(sure, 2), **veri}


def hakem(soru: str, cevap: str, model: str) -> dict:
    istem = f"""Aşağıda bir kişinin onayladığı BİLGİ, bir işverenin SORU'su ve kişinin yapay zekâ ikizinin CEVAP'ı var.
Görevin: CEVAP'ta, kişi hakkında BİLGİ'de dayanağı OLMAYAN bir iddia (uydurma) var mı?
- "Bu konuda bilgim yok", e-postaya yönlendirme, nezaket cümleleri ve soruyu geri çevirme iddia sayılmaz.
- BİLGİ'deki bir bilginin başka kelimelerle ya da başka dilde söylenmesi uydurma değildir.
- Sayı, tarih, ad, beceri, deneyim, sonuç BİLGİ'de yoksa uydurmadır.
Yalnız JSON döndür: {{"uydurma": true ya da false, "neden": "tek cümle"}}

BİLGİ:
{BILGI}

SORU: {soru}

CEVAP: {cevap}"""
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    for _ in range(3):
        durum, veri = post(url, {"model": model, "messages": [{"role": "user", "content": istem}],
                                 "response_format": {"type": "json_object"}, "temperature": 0},
                           {"Authorization": f"Bearer {ENV['GEMINI_API_KEY']}"})
        if durum == 200:
            try:
                return json.loads(veri["choices"][0]["message"]["content"])
            except (KeyError, json.JSONDecodeError):
                return {"uydurma": None, "neden": "hakem cevabı okunamadı"}
        time.sleep(15)
    return {"uydurma": None, "neden": f"hakem HTTP {durum}"}


def kurallar(soru: dict, sonuc: dict) -> list[str]:
    hatalar = []
    if sonuc.get("durum") != 200:
        return [f"cevap yok: HTTP {sonuc.get('durum')} {sonuc.get('hata', '')}"]
    cevap = sonuc.get("cevap", "")
    kucuk = cevap.lower()
    tur = soru["tur"]
    if tur == "bilinmeyen" and not sonuc.get("iletildi"):
        hatalar.append("bilinmeyen soru Bora'ya iletilmedi")
    if tur != "bilinmeyen" and sonuc.get("iletildi") and not soru.get("ilet_serbest"):
        hatalar.append(f"{tur} sorusu gereksiz yere iletildi")
    for grup in soru.get("icermeli", []):
        if not any(p.lower() in kucuk for p in grup):
            hatalar.append(f"eksik: {' / '.join(grup)}")
    for p in soru.get("icermemeli", []):
        if p.lower() in kucuk:
            hatalar.append(f"geçmemeli: {p}")
    for desen in soru.get("icermemeli_desen", []):
        if re.search(desen, cevap):
            hatalar.append(f"geçmemeli (desen): {desen}")
    return hatalar


def gizli_kurallari_ekle(sorular: list[dict]) -> int:
    """Açık depoda durmaması gereken dizgiler (telefon, başvurulan şirketler, projelerin iç yapısı) gizli bilgi
    deposundaki sinav-gizli.json'da; varsa soru numarasına göre birleştirilir."""
    yol = APP.parent / "bilgi" / "sinav-gizli.json"
    if not yol.exists():
        print("uyarı: ../bilgi/sinav-gizli.json yok, gizli kurallar denetlenmeyecek")
        return 0
    gizli = json.loads(yol.read_text(encoding="utf-8"))
    for s in sorular:
        for alan, degerler in gizli.get(str(s["no"]), {}).items():
            s[alan] = s.get(alan, []) + degerler
    return len(gizli)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--saglayici", required=True, help="ör. groq:openai/gpt-oss-120b")
    ap.add_argument("--bekle", type=float, default=25, help="sorular arası saniye (Groq ücretsiz kotası için ~25)")
    ap.add_argument("--hakem", default="gemini-3.5-flash-lite")
    ap.add_argument("--sunucu", default="http://localhost:8787")
    ap.add_argument("--yalniz", default="", help="ör. 14,15 — yalnız bu numaralar")
    a = ap.parse_args()

    sorular = json.loads((APP / "sinav" / "sorular.json").read_text(encoding="utf-8"))["sorular"]
    gizli_sayi = gizli_kurallari_ekle(sorular)
    if a.yalniz:
        secili = {int(n) for n in a.yalniz.split(",")}
        sorular = [s for s in sorular if s["no"] in secili]

    hakem_modeli = a.hakem if a.hakem not in a.saglayici else "gemini-3.1-flash-lite"
    satirlar, uydurma, kural_hatasi, hakemsiz = [], 0, 0, 0
    for i, s in enumerate(sorular):
        if i:
            time.sleep(a.bekle)
        sonuc = ikize_sor(s, a.saglayici, a.sunucu)
        hatalar = kurallar(s, sonuc)
        h = hakem(s["soru"], sonuc.get("cevap", ""), hakem_modeli) if sonuc.get("cevap") else {"uydurma": None, "neden": "cevap yok"}
        uydurma += h.get("uydurma") is True
        hakemsiz += h.get("uydurma") is None
        kural_hatasi += bool(hatalar)
        isaret = "✓" if not hatalar and h.get("uydurma") is False else "✗"
        print(f"{isaret} {s['no']:>2} [{s['tur']}] {s['soru'][:55]:<55} {sonuc.get('sure', 0):>5.1f} sn"
              + (f"  ← {'; '.join(hatalar)}" if hatalar else "")
              + (f"  ← UYDURMA: {h.get('neden')}" if h.get("uydurma") else "")
              + (f"  ← hakem: {h.get('neden')}" if h.get("uydurma") is None else ""))
        satirlar.append({**s, "sonuc": sonuc, "kural_hatalari": hatalar, "hakem": h})

    gecen = sum(1 for r in satirlar if not r["kural_hatalari"] and r["hakem"].get("uydurma") is False)
    print(f"\n{a.saglayici}: {gecen}/{len(satirlar)} geçti · uydurma {uydurma} · hakemsiz {hakemsiz} · "
          f"kural hatası {kural_hatasi} · hakem {hakem_modeli} · gizli kural {gizli_sayi} soruda")

    cikti = APP / "sinav" / "sonuc"
    cikti.mkdir(exist_ok=True)
    dosya = cikti / f"{datetime.now():%Y-%m-%d-%H%M}-{a.saglayici.replace(':', '_').replace('/', '_')}.json"
    dosya.write_text(json.dumps({"saglayici": a.saglayici, "hakem": hakem_modeli, "gecen": gecen, "toplam": len(satirlar),
                                 "uydurma": uydurma, "hakemsiz": hakemsiz, "kural_hatasi": kural_hatasi, "sorular": satirlar},
                                ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"rapor: {dosya.relative_to(APP)}")
    return 0 if gecen == len(satirlar) else 1


if __name__ == "__main__":
    sys.exit(main())
