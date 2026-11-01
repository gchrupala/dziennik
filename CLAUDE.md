# Dziennik — wskazówki dla Claude

## Sposób pracy

- **Pracujemy bezpośrednio na `main`.** Nie twórz gałęzi ani pull requestów, chyba że użytkownik wyraźnie o to poprosi
  (dotyczy to także gałęzi sugerowanych przez środowisko/harness).
- Commituj i pushuj prosto na `main`: `git push origin main`.
- Odpowiedzi krótko i na temat.

## Co to jest

Prosta aplikacja webowa (PWA) do nagrywania fragmentów raportu z podróży. Każdy fragment:

- nagrywa dźwięk (MediaRecorder) i **jednocześnie** robi transkrypcję w jednym z języków: polski (`pl-PL`),
  hiszpański (`es-ES`), angielski (`en-US`); język można zmienić w trakcie nagrania,
- **transkrypcja musi działać bez internetu (wymaganie kluczowe).** Z internetem: Web Speech API (na żywo).
  Bez internetu: Whisper w przeglądarce (transformers.js, Web Worker, WASM) — dźwięk 16 kHz z AudioWorklet
  jest cięty na fragmenty 18–28 s w miejscach ciszy, tekst pojawia się z opóźnieniem. Przełączanie jest
  automatyczne w trakcie nagrania (błąd `network` → Whisper; rozpoznawanie wraca → Whisper się wyłącza).
  Opcja „zawsze Whisper” w Ustawieniach. Model (base ≈80 MB / small ≈250 MB, q8) pobiera się raz w Ustawieniach
  (Cache Storage `transformers-cache`),
- automatycznie zapisuje lokalizację (Geolocation API) i — jeśli jest internet — nazwę miejsca (Nominatim/OSM)
  oraz warunki pogodowe (Open-Meteo, bez klucza API). Brakujące dane uzupełniają się później, gdy wróci internet
  (pogoda historyczna z danych godzinowych Open-Meteo, do ~3 miesięcy wstecz),
- pozwala dodać zdjęcia, dokumenty i notatkę tekstową; transkrypcję można poprawiać ręcznie.

Bliskie wpisy (następny zaczął się ≤ 10 min po końcu poprzedniego, ten sam dzień, ≤ 200 m albo brak lokalizacji)
są grupowane pod jednym nagłówkiem na liście i w `dziennik.md` (`groupFragments()` w `js/context.js`). Dane się nie zmieniają.
Szczegóły wpisu otwierają się do czytania (bez pól, bez usuwania); „✎ Edytuj” włącza edycję, „✓ Gotowe” ją kończy.
Nowy wpis bez nagrania otwiera się od razu w edycji.
Grupa i dzień to widoki do czytania: wszystkie wpisy po kolei z nagraniami, tekstem, zdjęciami i dokumentami
(pliki wczytywane przy przewinięciu, IntersectionObserver). Karta w grupie i nagłówek grupy prowadzą do widoku grupy,
nagłówek dnia na liście do widoku dnia. Ikona udostępniania (widoki do czytania): Web Share z tekstem (data, godziny, miejsce, pogoda, transkrypcje, notatki)
i zdjęciami (JPEG); tekst idzie też do schowka (Signal przy zdjęciach pomija tekst, WhatsApp nie). Bez Web Share — schowek. „✎ Edytuj” przy wpisie otwiera go w edycji; „Gotowe” wraca na to samo miejsce.

Można też utworzyć wpis bez nagrania (sama notatka/zdjęcia + lokalizacja i pogoda).
Dane są lokalnie w przeglądarce (IndexedDB) i synchronizują się z prywatnym repo **`gchrupala/app-data`**
(GitHub REST API, Contents; fine-grained token wpisany w Ustawieniach, trzymany w localStorage). Układ w repo
zgodny z innymi aplikacjami (`<profil>/<aplikacja>.json`):

```
<profil>/dziennik.json      wszystkie wpisy (metadane + lista plików z `path`), `deleted` = usunięte id
<profil>/dziennik.md        czytelny raport (generowany)
<profil>/dziennik/<RRRR-MM-DD>_<GGMM>_<id8>/<fileId8>_<nazwa>   nagrania, zdjęcia, dokumenty
```

Synchronizacja (`js/sync.js`) jest dwukierunkowa: nowszy `updatedAt` wygrywa, brakujące pliki są pobierane/wysyłane,
JSON/MD zapisywane tylko przy zmianie (brak pustych commitów), konflikt sha → ponowienie. Uruchamia się sama
(start, powrót internetu, 20 s po zmianie). Commity: `Dziennik: <co> <ISO>`.

## Struktura

```
index.html            szkielet UI
css/style.css         style (mobile-first, jasny/ciemny motyw)
js/app.js             widoki (lista, szczegóły, grupa, dzień, nagrywanie, ustawienia), routing przez hash:
                      #/ lista, #/f/<id> wpis, #/g/<id pierwszego>[/<id>] grupa, #/d/RRRR-MM-DD dzień
js/recorder.js        RecordingSession: MediaRecorder + SpeechRecognition (auto-restart, offline, zmiana języka)
js/whisper.js         Whisper: pobieranie/wybór modelu, kolejka transkrypcji, dekodowanie i cięcie nagrań
js/whisper-worker.js  worker z transformers.js (import z jsDelivr, wersja przypięta)
js/pcm-worklet.js     AudioWorklet zbierający próbki 16 kHz dla Whispera
js/share.js           udostępnianie: tekst + zdjęcia (Web Share), tekst także do schowka
js/photos.js          podglądy JPEG zdjęć HEIC/HEIF (oryginał zostaje), `ensurePreviews()`, `displayFile()`
js/heic-worker.js     worker: dekodowanie HEIC (heic-to/libheif), zmniejszenie do 2048 px, JPEG
js/sync.js            synchronizacja z GitHub (app-data)
js/context.js         lokalizacja, odwrotne geokodowanie, pogoda, uzupełnianie braków
js/db.js              IndexedDB: store `fragments` (metadane) i `files` (bloby: audio, zdjęcia, dokumenty)
sw.js                 service worker: offline, cache jsDelivr (cache-first), nagłówki COOP/COEP (wątki WASM)
manifest.webmanifest  manifest PWA
icons/                ikony (icon.svg jest źródłem; PNG generowane z niego)
```

Model fragmentu (`fragments`): `id, createdAt, updatedAt, status ('recording'|'done'|'interrupted'),
kind ('audio'|'text'), appVersion, autoStopSec, langs[], transcript, transcribedBy[], transcribing, notes, audioId, durationMs, location, weather, attachments[]`.
`appVersion` = wersja aplikacji przy tworzeniu wpisu (diagnostyka), `autoStopSec` = ustawienie końca po ciszy w tym nagraniu.
`transcribedBy[]` = jak powstał tekst, w kolejności: `live-browser` (na żywo, przeglądarka), `live-device` (na żywo,
`processLocally`), `live-whisper:<model>` (na żywo, Whisper), `whisper:<model>` (po nagraniu, cały plik; zastępuje
wcześniejsze), `manual` (poprawka ręczna); opis w `describeMethods()` (`js/recorder.js`), widoczny w szczegółach i w raporcie MD.
`transcribing: true` = Whisper kończy w tle (pole tylko do odczytu); po restarcie aplikacji nagranie jest transkrybowane od nowa.
`attachments` trzyma tylko metadane (`id, kind ('photo'|'document'), name, type, size, preview?`); bloby są w `files`.
Zdjęcie HEIC dostaje `preview: {id, name, type: 'image/jpeg', size}` (plik `kind: 'preview'` w `files`, w repo obok oryginału,
w `dziennik.json` jako plik z `kind: 'preview', of: <id zdjęcia>`). Podglądy powstają w tle przy starcie, po dodaniu zdjęcia i po powrocie internetu.
Nagranie kończy się samo po ciszy (domyślnie 60 s, Ustawienia → Nagrywanie; `dziennik.autoStop` w localStorage,
ostatnie 10 s z odliczaniem). Poziom mowy liczony z bloków AudioWorklet (`silentMs()` w `js/recorder.js`; mowa = 3 z 4 bloków 0,25 s powyżej 0,02, krótkie stuknięcia się nie liczą), bo działają też przy wygaszonym ekranie.
Audio jest zapisywane co 10 s w trakcie nagrania, więc przerwane nagranie nie przepada (status `interrupted`).

## Konwencje

- Czysty JavaScript (moduły ES), **bez kroku budowania i bez zależności npm**. Jedyny zewnętrzny kod z jsDelivr (wersje przypięte):
  transformers.js (`js/whisper-worker.js`; ONNX Runtime WASM i model cache'owane przez bibliotekę) i heic-to (`js/heic-worker.js`).
- Interfejs po polsku.
- Zmiana schematu IndexedDB → podbij `VERSION` w `js/db.js` i dopisz migrację w `onupgradeneeded`.
- **Wersjonowanie:** przed każdym commitem zmieniającym pliki aplikacji uruchom `tools/bump-version.sh`.
  Podbija wersję (znacznik czasu UTC) w `?v=…` wszystkich importów/odnośników, w nazwie cache `sw.js` i w `APP_VERSION`
  (widoczna w Ustawieniach). Nowy import modułu pisz z tym samym `?v=` co pozostałe (inaczej moduł załaduje się dwa razy).
- Nowy plik statyczny → dopisz go do `SHELL` w `sw.js`.

## Uruchamianie

```
python3 -m http.server 8000   # potem http://localhost:8000
```

Mikrofon i lokalizacja wymagają HTTPS albo `localhost`. Service worker: przy internecie zawsze najnowsze pliki
(sieć z `cache: 'no-cache'`, limit 4 s), offline — kopia z cache. Nowy `sw.js` przejmuje stronę i aplikacja
sama się przeładowuje (`controllerchange`; w trakcie nagrania dopiero po jego zakończeniu).

Hosting: GitHub Pages z gałęzi `main`, katalog główny (plik `.nojekyll` wyłącza Jekylla).
Adres: https://grzegorz.chrupala.me/dziennik/ (gchrupala.github.io przekierowuje na własną domenę; cache HTTP 10 min).

## Testowanie

Brak testów automatycznych w repo. Do sprawdzenia w przeglądarce headless służy Playwright
(Chromium z `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, zamockowane
`SpeechRecognition`, geolokalizacja i odpowiedzi Open-Meteo/Nominatim). Whisper: mowa z `espeak-ng -v pl`
podana przez `--use-file-for-fake-audio-capture=plik.wav`, `context.setOffline(true)` po pobraniu modelu.
Prawdziwe `SpeechRecognition` w headless Chromium wywraca kartę — zawsze je mockuj.

## Znane ograniczenia

- Transkrypcja na żywo działa w Chrome (Android/desktop) i Safari (iOS/macOS); Firefox nagrywa sam dźwięk.
- Web Speech na Androidzie idzie przez systemową usługę mowy Google — działa offline, jeśli w telefonie są pobrane
  języki offline (tak działa w MaxApkach, gdzie nic innego nie używa mikrofonu). Poza Androidem (i bez modelu) aplikacja
  najpierw próbuje Web Speech, a Whisper włącza dopiero po błędzie `network`. `SpeechRecognition.available({processLocally})` (moduł Chrome) na Androidzie
  zwraca `unavailable` — to nie znaczy, że offline nie działa.
- Whisper nie jest strumieniowy: tekst offline pojawia się co ~20–30 s; na wolnym telefonie (model small)
  może nie nadążać — kolejka kończy się po zatrzymaniu nagrania. Dodatkowo przycisk „Transkrybuj nagranie offline”.
- Whisper „halucynuje” na ciszy — ciche fragmenty są pomijane; `max_new_tokens` ogranicza zapętlenia.
- **Android:** rozpoznawanie mowy przeglądarki nie dostaje dźwięku, gdy aplikacja nagrywa (sprawdzone na telefonie,
  zarówno `start()`, jak i `start(track)`), a każdy jego start pipa (systemowa usługa mowy; strona nie może tego wyłączyć).
  Dlatego na Androidzie z pobranym modelem transkrypcję na żywo robi tylko Whisper (`isAndroid` w `js/recorder.js`).
  Bez modelu jest jedna próba; po 8 s mowy bez wyniku aplikacja przestaje próbować (żeby nie pipało).
- Na innych platformach rozpoznawanie mowy i nagrywanie korzystają z mikrofonu równocześnie. Rozpoznawanie startuje jak
  w MaxApkach (`start()` bez argumentów). Gdy mikrofon słyszy mowę, a przez 8 s nie ma wyniku, aplikacja próbuje
  `start(track)` (ścieżka z getUserMedia), a potem Whispera. Po nagraniu bez transkrypcji (albo z takim zacięciem)
  całe nagranie jest automatycznie przepisywane Whisperem, jeśli model jest pobrany.
- Synchronizacja wysyła każdy plik osobnym commitem (Contents API); pliki > ~50 MB mogą nie przejść.
- Pliki już wysłane nie są ponownie wysyłane (załączniki i nagrania się nie zmieniają).
- Zdjęcie/dokument usunięte z wpisu (i pliki usuniętych wpisów) są kasowane z repo przy synchronizacji, po zapisaniu JSON.
  O usunięciu decydują metadane wpisu (`audioId`, `attachments`), nie obecność blobu w IndexedDB.
