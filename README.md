# Ďatelinka

Platforma pre Materskú školu Ďatelinka vo Zvolene. Slúži na nástenku s oznamami, odhlasovanie detí aj stravy, dochádzku, správy s učiteľkami, suplovanie a jedálny lístok.

Frontend je statické PWA bez build kroku (HTML, CSS a vanilla JS), hostované na **GitHub Pages**. Backend tvorí **Supabase**: Postgres s RLS, prihlásenie e-mailom a heslom so schvaľovaním riaditeľkou a Edge Function na push notifikácie.

```
index.html, style.css, app.js     platforma
config.js                         URL a verejný kľúč Supabase, VAPID public key
sw.js, manifest.webmanifest       PWA (inštalácia na plochu, push)
supabase/migrations/…_init.sql    celá databáza: tabuľky, RLS, uzávierka stravy
supabase/functions/push/          odosielanie push notifikácií
```

---

## 1. Supabase (cca 15 min)

1. **Nový projekt.** Región zvoľ **Central EU (Frankfurt)** kvôli GDPR, dáta zostanú v EÚ.
2. **SQL Editor.** Postupne spusti oba súbory zo `supabase/migrations/` v poradí podľa názvu (Run). Vytvoria tabuľky, pravidlá prístupu, registráciu so schvaľovaním a triedy Kvietky, Slniečka a Lienky.
3. **Authentication → Sign In / Providers → Email.** Nechaj zapnuté **Allow new users to sign up** a vypni **Confirm email**. Registrácia tak nepotrebuje e-maily. Neschválený účet nevidí nič, kým ho riaditeľka neschváli.
4. **Prvý admin.** Zaregistruj sa v platforme a v SQL Editore spusti:
   ```sql
   update profiles set role = 'admin', approved = true where email = 'tvoj@email.sk';
   ```
5. **SMTP** zatiaľ netreba. Bude potrebné až pre „zabudnuté heslo“, ktoré ešte nie je hotové. Dovtedy heslo resetuješ v **Authentication → Users**.
6. **Authentication → URL Configuration.** Ako Site URL nastav adresu z GitHub Pages (krok 2), napríklad `https://tvoje-meno.github.io/datelinka/`. Tú istú adresu, prípadne aj `http://localhost:8000`, pridaj do Redirect URLs.
7. **Project Settings → API Keys.** Skopíruj Project URL a **Publishable key** do `config.js`. Secret alebo service_role kľúč do repozitára nikdy nedávaj.

## 2. GitHub Pages

```bash
git init && git add . && git commit -m "Ďatelinka – prvá verzia"
git branch -M main
git remote add origin git@github.com:TVOJE-MENO/datelinka.git
git push -u origin main
```

Potom v repozitári otvor **Settings → Pages → Build and deployment**, zvoľ **Deploy from a branch** a nastav `main` / `(root)`. O minútu beží na `https://TVOJE-MENO.github.io/datelinka/`.

Lokálne ju spustíš cez `python3 -m http.server 8000` a otvoríš http://localhost:8000.

## 3. Používatelia a deti

Všetko robí riaditeľka v platforme cez **Vedenie → Používatelia**:

1. **Pridá deti** (meno a trieda).
2. Rodič sa **zaregistruje sám**: zadá meno, e-mail, heslo a meno dieťaťa. Kým ho nikto neschváli, vidí len „Účet čaká na schválenie“.
3. Riaditeľka vidí čakajúcich aj s **navrhnutou zhodou**. Deti, ktorých meno sa zhoduje s uvedeným menom, sú predvybraté (porovnáva sa bez diakritiky, podľa mena alebo priezviska). Skontroluje ich, doplní rolu (rodič, učiteľka, kuchyňa) a klikne **Schváliť**.
4. Učiteľky sa registrujú tiež. Pri schválení im riaditeľka dá rolu **Učiteľka**. Priradenie učiteľky k triede je zatiaľ v **Table Editor → class_teachers** (`class_id` + `teacher_id`), prípadne SQL:
   ```sql
   insert into class_teachers select (select id from classes where name = 'Lienky'), id from profiles where email = 'ucitelka@example.sk';
   ```

Rolu si pri registrácii nikto nevie nastaviť sám. Databáza ju ignoruje a mení ju len admin.

## 4. Push notifikácie (dajú sa zapnúť aj neskôr)

Bez tohto kroku platforma funguje, len bez upozornení.

1. Vygeneruj kľúče príkazom `npx web-push generate-vapid-keys` a **Public Key** vlož do `config.js` (`VAPID_PUBLIC_KEY`).
2. Nasaď funkciu. `REF` je ID projektu z URL `https://REF.supabase.co`.
   ```bash
   npx supabase login
   npx supabase secrets set --project-ref REF \
     VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
     VAPID_SUBJECT=mailto:tvoj@email.sk WEBHOOK_SECRET=nejaky-dlhy-nahodny-retazec
   npx supabase functions deploy push --project-ref REF --no-verify-jwt
   ```
3. V **Database → Webhooks** vytvor 3 webhooky, pre tabuľky `posts`, `messages` a `absences`. Každý má event **Insert**, typ **HTTP Request**, metódu **POST**, URL `https://REF.supabase.co/functions/v1/push` a HTTP header `x-webhook-secret` s hodnotou `WEBHOOK_SECRET`.
4. V platforme ťukni na **Zapnúť upozornenia**. Na iPhone treba iOS 16.4 alebo novší. V Safari daj **Zdieľať → Pridať na plochu**, otvor platformu z plochy a až potom zapni upozornenia.

Kto dostane upozornenie:
- nový oznam: rodičia triedy, alebo celej MŠ
- nová správa: rodičia dieťaťa a učiteľky jeho triedy
- odhlásenie dieťaťa: učiteľky triedy

---

## Pravidlá zo školského poriadku

- **Strava sa odhlasuje do 8:00 v deň neprítomnosti.** Uzávierku stráži databáza v triggeri `absences_before_insert`, takže ju nedá obísť ani upravený klient. Pole `meals_from` hovorí, od ktorého dňa je strava odhlásená. Z neho sa počítajú porcie pre kuchyňu (`meal_counts`).
- Odhlásenie sa dá zrušiť len vtedy, ak ešte neprebehla uzávierka jeho prvého dňa.
- Pri neprítomnosti 5 a viac dní platforma pripomenie vyhlásenie o bezinfekčnosti, nad 7 dní potvrdenie od lekára.
- Oprávnenú osobu na vyzdvihnutie pridá rodič. Platná je až vtedy, keď učiteľka potvrdí písomné splnomocnenie.

## Kto čo vidí (RLS)

| Rola | Vidí | Môže |
|---|---|---|
| Rodič | svoje deti, oznamy ich tried a celej MŠ, mená učiteliek | odhlásiť dieťa, písať správy, potvrdiť oznam, hlasovať, pridať osobu na vyzdvihnutie |
| Učiteľka | všetky deti a triedy (kvôli záskokom) | dochádzka, oznamy, správy, potvrdenie splnomocnení |
| Riaditeľka (`admin`) | všetko | navyše suplovanie, výkaz dochádzky (CSV) a jedálny lístok |
| Kuchyňa | len počty porcií podľa triedy, bez mien detí | jedálny lístok |

## Zámerne vynechané (ďalšie kroky)

- **Zdravotné údaje** (alergie, choroby, diéty) sú v platforme zamknuté s označením „Podlieha GDPR“ a databáza ich neukladá. Sprístupnia sa až po zmluve o spracúvaní so škôlkou alebo mestom.
- **Zabudnuté heslo** (potrebuje SMTP), **zamietnutie registrácie** (zatiaľ zmazať v Authentication → Users) a **priradenie učiteliek k triedam** v platforme.
- **Platby**, **fotogaléria** a **núdzové kontakty.**
- **Realtime.** Dáta sa obnovia po každej akcii a pri návrate do platformy. Pri 3 triedach to stačí.
- **Offline režim.** Service worker zatiaľ obsluhuje len push.

## GDPR pred spustením

- [ ] Zmluva o spracúvaní osobných údajov medzi škôlkou alebo mestom (prevádzkovateľ) a tebou (sprostredkovateľ)
- [ ] Informácia pre rodičov: čo sa ukladá, kto to vidí a ako dlho
- [ ] Supabase v EÚ regióne a akceptovaná DPA od Supabase
- [ ] Po odchode dieťaťa nastaviť `children.active = false` a do 30 dní dieťa zmazať (zmažú sa aj jeho odhlásenia, správy a podobne)
