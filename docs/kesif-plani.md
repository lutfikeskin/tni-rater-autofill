# GEICO keşif planı

Bu plan, Progressive ve AmWINS'in depoya nasıl eklendiğine dayanıyor (`docs/new-carrier.md`, `src/carriers/amwins.js`, `src/carriers/progressive.js`). Uzantıda GEICO zaten kayıtlı ama boş: `src/carriers.js` içinde `*.geico.com` adresi tanımlı, kuralı yok, yalnızca genel etiket kuralları çalışıyor.

## Yarından önce (5 dakika)

1. Son ana dal sürümünü (unpacked) Chrome'a yükleyin.
2. Gerçek müşteri yerine örnek intake'i kullanın: `intake-form-2026-10/sample-intake-2026-10-filled.pdf`. Panelde Settings → Advanced (for setup) altında **This intake is a test run, not a client** kutusunu işaretleyin.
3. Kayıt (capture) için intake'in yüklü olması şart. Panel, sayfadaki müşteri adlarını ve numaralarını bu intake'e göre `[client]` ile gizliyor.

## Yarın: ilk 10 dakika

- **GEICO'nun ticari teklif sayfasının adresini not edin.** Kayıt yalnızca `*.geico.com` alan adında çalışıyor. Teklif başka bir alan adında açılıyorsa (portal veya üçüncü taraf bir rater), panel "Open a carrier page to capture its layout" der. O durumda adresi buraya yazın, alan adını aynı gün ekleyip yeni bir yapı vereyim.
- İlk sayfada bir kayıt alıp çalıştığını doğrulayın.

## Nasıl kayıt alınır

Panel → Settings → Advanced (for setup):

1. **Scenario** alanına bir ad verin, örneğin `temel-1arac-1surucu`.
2. Sayfaya gelince **Alt+Shift+C** tuşlarına basın. Dosya İndirilenler klasörüne `capture-geico-...json` adıyla düşer.
3. **Bir cevabı değiştirin**, *Note* alanına ne yaptığınızı yazın (örn. "hazmat Yes yapıldı") ve tekrar Alt+Shift+C'ye basın. Yeni çıkan veya kaybolan sorular bu iki kaydın farkından çıkarılıyor.
4. Açılır listeleri (dropdown) **açıkken** kaydedin. Kısayol liste açıkken de çalışır ve seçenekler bu şekilde kaydediliyor.
5. Ekranda hata ya da uyarı çıkarsa (zorunlu alan, ret mesajı) o anda da kayıt alın.
6. Ayrıca her sayfayı **Ctrl+S → "Web Page, Complete"** ile kaydedin. AmWINS'te test sayfasını (mock) bu kayıtlı sayfalardan kurmuştuk; GEICO'da da en hızlı yol bu.

Kayıtlar yalnızca bilgisayarınıza iner, sunucuya gönderilmez.

## Hangi senaryolar

Her seferinde tek bir cevabı değiştirin ve her değişiklikten sonra kayıt alın. Önce temel akışı baştan sona yürüyün:

| Sıra | Senaryo | Değiştirilecek cevap |
| --- | --- | --- |
| 1 | Temel | 1 araç, 1 sürücü, örnek intake'in cevapları; teklifin son adımına kadar, **satın alma, bağlama (bind) veya gönderim olmadan** |
| 2 | Sürücü/araç sayısı | 2. sürücü ve 2. araç ekleyin (tekrarlayan satırlar nasıl çiziliyor?) |
| 3 | Römork | Römork ekleyin |
| 4 | Faaliyet | Hazmat Yes/No, kiralık taşıma (for-hire), eyaletler arası, Kanada'ya yük |
| 5 | Teminat | Farklı limitler, cargo, physical damage açık/kapalı |
| 6 | Geçmiş | Önceki sigorta var/yok, hasar var/yok, yeni USDOT |
| 7 | Eyalet | En sık teklif verdiğiniz ikinci eyalet |

Ayrıca bir yere şunları not edin: sayfaların sırası (panelin adım şeridi için), VIN veya DOT ile yapılan otomatik doldurmalar ya da sorgular (lookup), sayfa değiştiğinde sunucuya gidip gelip gitmediği ve GEICO'nun ret ya da "agent'ı arayın" dediği durumlar.

## Kayıtları bana nasıl ulaştırırsınız

İndirilen `capture-geico-*.json` dosyalarını ve kaydettiğiniz sayfaları onaylı klasöre koyun: `C:\Users\Lutfy\Documents\ChatGPT\TNI Autofill` altında `layouts\geico\`. Ardından buraya yazmanız yeterli; dosyaları oradan okurum. Ham sayfalar ve kayıtlar depoya girmiyor (`layouts/` git dışında).

**Bitirmeyi beklemeyin.** İlk sayfanın kayıtları gelir gelmez adaptöre başlarım, sonrasını paralel yürütürüz.

## Sonra ne olacak (benim tarafım)

1. `npm run captures` ile senaryoları önce/sonra raporuna çevirip her soru için GEICO'nun kendi kullandığı kalıcı bir tanımlayıcıyı (veri adı, id, name) belirlerim. Sıra numarası veya yalnızca etiket tanımlayıcı sayılmaz.
2. `src/carriers/geico.js`: intake'teki karşılıkları, TNI standartlarını (`docs/intake-and-rules.md`'de kayıtlı olanlar) ve agent'a bırakılacak soruları tanımlarım. `layoutUrl` ve `quoteSteps`'i de eklerim; böylece agent'lar çalıştıkça GEICO sayfaları kullanım kayıtlarına kendiliğinden girer.
3. Kayıtlı sayfalardan bir GEICO test sayfası kurarım (AmWINS'teki `amwins-mock.mjs` gibi); beklenen cevaplar, koşullu sorular ve "son gönderim yok" kontrolleri bu sayfa üzerinde test edilir.
4. PR'ı açıp size inceletirim; birleştirdiğinizde sürüm yükseltilir.
5. Gözetimli pilot: gerçek bir teklifte siz izlerken doldurulur. Ardından haftalık incelemede (`npm run coverage`, agent raporları) eksik soruları kapatırız.

## Bilinmesi gerekenler

- Test sayfasında başarılı olmak GEICO sunucusunun cevabı kabul ettiğini kanıtlamaz; bu yüzden pilot şart.
- İntake'te cevabı olmayan ve TNI standardı da olmayan GEICO soruları agent'a bırakılır, uydurulmaz. Yarın böyle bir soruya TNI'nin hep aynı cevabı verdiğini görürseniz not edin; o zaman standart olarak eklenebilir.
- Hiçbir adımda bind, satın alma, imza veya rapor siparişi (MVR/CLUE) yapmayın.
