# Dziennik podróży — wskazówki dla Claude

## Sposób pracy

- **Pracujemy bezpośrednio na `main`.** Nie twórz gałęzi ani pull requestów, chyba że użytkownik wyraźnie o to poprosi
  (dotyczy to także gałęzi sugerowanych przez środowisko/harness).
- Commituj i pushuj prosto na `main`: `git push origin main`.
- Odpowiedzi krótko i na temat.

## Co to jest

Prosta aplikacja webowa (PWA) do nagrywania fragmentów raportu z podróży. Każdy fragment:

- nagrywa dźwięk (MediaRecorder) i **jednocześnie** robi transkrypcję na żywo (Web Speech API)
  w jednym z języków: polski (`pl-PL`), hiszpański (`es-ES`), angielski (`en-US`); język można zmienić w trakcie nagrania,
- automatycznie zapisuje lokalizację (Geolocation API) i — jeśli jest internet — nazwę miejsca (Nominatim/OSM)
  oraz warunki pogodowe (Open-Meteo, bez klucza API). Brakujące dane uzupełniają się później, gdy wróci internet
  (pogoda historyczna z danych godzinowych Open-Meteo, do ~3 miesięcy wstecz),
- pozwala dodać zdjęcia, dokumenty i notatkę tekstową; transkrypcję można poprawiać ręcznie.

Można też utworzyć wpis bez nagrania (sama notatka/zdjęcia + lokalizacja i pogoda).
Wszystko jest przechowywane lokalnie w przeglądarce (IndexedDB), bez serwera.

## Struktura

```
index.html            szkielet UI
css/style.css         style (mobile-first, jasny/ciemny motyw)
js/app.js             widoki (lista, szczegóły, nagrywanie, ustawienia), routing przez hash (#/ i #/f/<id>)
js/recorder.js        RecordingSession: MediaRecorder + SpeechRecognition (auto-restart, offline, zmiana języka)
js/context.js         lokalizacja, odwrotne geokodowanie, pogoda, uzupełnianie braków
js/db.js              IndexedDB: store `fragments` (metadane) i `files` (bloby: audio, zdjęcia, dokumenty)
sw.js                 service worker (stale-while-revalidate, działa offline)
manifest.webmanifest  manifest PWA
icons/                ikony (icon.svg jest źródłem; PNG generowane z niego)
```

Model fragmentu (`fragments`): `id, createdAt, updatedAt, status ('recording'|'done'|'interrupted'),
kind ('audio'|'text'), langs[], transcript, notes, audioId, durationMs, location, weather, attachments[]`.
`attachments` trzyma tylko metadane (`id, kind ('photo'|'document'), name, type, size`); bloby są w `files`.
Audio jest zapisywane co 10 s w trakcie nagrania, więc przerwane nagranie nie przepada (status `interrupted`).

## Konwencje

- Czysty JavaScript (moduły ES), **bez kroku budowania i bez zależności npm**.
- Interfejs po polsku.
- Zmiana schematu IndexedDB → podbij `VERSION` w `js/db.js` i dopisz migrację w `onupgradeneeded`.
- Nowy plik statyczny → dopisz go do `SHELL` w `sw.js`. Przy większych zmianach podbij `CACHE` w `sw.js`.

## Uruchamianie

```
python3 -m http.server 8000   # potem http://localhost:8000
```

Mikrofon i lokalizacja wymagają HTTPS albo `localhost`. Service worker serwuje najpierw wersję z cache,
więc po zmianach przeładuj stronę dwa razy (albo wyłącz cache w DevTools).

Hosting: GitHub Pages z gałęzi `main`, katalog główny (plik `.nojekyll` wyłącza Jekylla).

## Testowanie

Brak testów automatycznych w repo. Do sprawdzenia w przeglądarce headless służy Playwright
(Chromium z `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, zamockowane
`SpeechRecognition`, geolokalizacja i odpowiedzi Open-Meteo/Nominatim).

## Znane ograniczenia

- Transkrypcja na żywo działa w Chrome (Android/desktop) i Safari (iOS/macOS); Firefox nagrywa sam dźwięk.
- Chrome zwykle wysyła dźwięk do rozpoznawania na serwery Google, więc bez internetu transkrypcja staje
  (dźwięk nagrywa się dalej). Nowsze Chrome mają rozpoznawanie na urządzeniu — modele pobiera się w Ustawieniach.
- Na Androidzie rozpoznawanie mowy i nagrywanie korzystają z mikrofonu równocześnie; aplikacja przekazuje
  ścieżkę audio do `SpeechRecognition.start(track)` tam, gdzie przeglądarka to obsługuje. Trzeba testować na telefonie.
- Dane są tylko na urządzeniu — brak eksportu/kopii zapasowej (kandydat na kolejny krok).
