# Ďatelinka

Platforma pre Materskú školu Ďatelinka vo Zvolene. Slúži na nástenku s oznamami, odhlasovanie detí aj stravy, dochádzku, správy s učiteľkami, suplovanie a jedálny lístok.

Frontend je statické PWA bez build kroku (HTML, CSS a vanilla JS), hostované na **GitHub Pages**. Backend tvorí **Supabase**: Postgres s RLS, prihlásenie e-mailom a heslom so schvaľovaním riaditeľkou zvonček s upozorneniami a Edge Function na push notifikácie.

```
index.html, style.css, app.js     platforma
config.js                         URL a verejný kľúč Supabase, VAPID public key
sw.js, manifest.webmanifest       PWA (inštalácia na plochu, push)
supabase/migrations/…_init.sql    celá databáza: tabuľky, RLS, uzávierka stravy
supabase/functions/push/          odosielanie push notifikácií
scripts/setup-push.sh             jednorazové nastavenie push
```

---

## 1. Supabase (cca 15 min)

1. **Nový projekt.** Región zvoľ **Central EU (Frankfurt)** kvôli GDPR, dáta zostanú v EÚ.
2. **SQL Editor.** Postupne spusti všetky súbory zo `supabase/migrations/` v poradí podľa názvu (Run). Vytvoria tabuľky, pravidlá prístupu, registráciu so schvaľovaním, realtime a triedy Kvietky, Slniečka a Lienky.
3. **Authentication → Sign In / Providers → Email.** Nechaj zapnuté **Allow new users to sign up** a vypni **Confirm email**. Registrácia tak nepotrebuje e-maily. Neschválený účet nevidí nič, kým ho riaditeľka neschváli.
4. **Prvý admin.** Zaregistruj sa v platforme a v SQL Editore spusti:
   ```sql
   update profiles set role = 'admin', approved = true where email = 'tvoj@email.sk';
   ```
5. **SMTP (pre „zabudnuté heslo“).** Vstavaný e-mail Supabase posiela len členom tímu a pár správ za hodinu, na rodičov nestačí. V **Authentication → Emails → SMTP Settings** zapni **Custom SMTP** a zadaj údaje vlastného poskytovateľa (napríklad Brevo alebo Resend, oba majú bezplatný plán, alebo Gmail s heslom aplikácie: `smtp.gmail.com`, port 465). Ako odosielateľa nastav adresu, ktorú poskytovateľ overil. Text e-mailu upravíš v **Authentication → Emails → Reset password**.
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
4. Učiteľky sa registrujú tiež. Pri schválení im riaditeľka dá rolu **Učiteľka** a v **Vedenie → Personál** im vyberie triedu.

Rolu si pri registrácii nikto nevie nastaviť sám. Databáza ju ignoruje a mení ju len admin.

## 4. Push notifikácie (dajú sa zapnúť aj neskôr)

Zvonček v platforme funguje hneď po spustení migrácií. Push (upozornenie na uzamknutom telefóne) treba nastaviť raz:

1. Migrácia `…_notifikacie.sql` už beží (krok 1). Vytvorí upozornenia, ktoré generuje samotná databáza pri novom oznamu, správe alebo odhlásení.
2. Prihlás sa do Supabase CLI a spusti skript. `REF` je ID projektu z URL `https://REF.supabase.co`.
   ```bash
   npx supabase login
   ./scripts/setup-push.sh REF tvoj@email.sk
   ```
   Skript vygeneruje VAPID kľúče, nahrá ich a tajný reťazec do Supabase, nasadí funkciu `push` a zapíše verejný kľúč do `config.js`.
3. Skript na konci vypíše jeden SQL príkaz. Vlož ho do **SQL Editora** a spusti. Tým databáza zistí, kam má push posielať.
4. Zmenený `config.js` nahraj na GitHub.
5. V platforme otvor **Menu → Nastavenie upozornení**, ťukni na **Zapnúť na tomto zariadení** a potvrď povolenie. Tlačidlom **Poslať skúšobné upozornenie** overíš, že to funguje. Na iPhone treba iOS 16.4 alebo novší, stránku pridať na plochu a zapnúť upozornenia až z plochy.

Ako to ide: nová správa, oznam alebo odhlásenie → trigger vloží riadok do `notifications` (to je zvonček) → ďalší trigger zavolá funkciu `push` → tá pošle upozornenie na zariadenia adresáta. Každý si v nastaveniach vie druhy upozornení vypnúť.

Migrácia `…_pripomienky.sql` navyše každý pracovný deň o 7:30 pošle rodičom pripomienku, že stravu možno odhlásiť do 8:00 (nepošle sa, ak je dieťa už odhlásené, a rodič ju vie vypnúť v nastaveniach), a upozornenia staršie ako 7 dní maže. Využíva rozšírenie pg_cron. Ak ho migrácia nevie zapnúť, zapni ho v **Database → Extensions** a spusti migráciu znova.

Kto dostane upozornenie:
- nový oznam: rodičia triedy, alebo celej MŠ
- nová správa: rodičia dieťaťa a učiteľky jeho triedy (okrem odosielateľa)
- odhlásenie dieťaťa: učiteľky triedy

---

## 5. Správa školy (migrácia `…_sprava_skoly.sql`)

- **Dni voľna** (sviatky, riaditeľské voľno): Kalendár (admin) → blok Dni voľna. V tieto dni neplatí odhlasovanie, výkaz ani pripomienka. Dá sa pridať aj SQL: `insert into closed_days(day, note) values ('2026-12-24','Štedrý deň');`
- **Nový školský rok:** Používatelia → presun tried a hromadný import detí.
- **Ďalšie dieťa:** rodič ho žiada v karte dieťaťa, riaditeľka potvrdí v Používateľoch.
- **2FA pre admina:** Menu → Dvojfaktorové overenie (Google Authenticator a pod.). Strata telefónu: v Supabase **Authentication → Users** zmaž faktor daného účtu.
- **Captcha (nepovinné):** Cloudflare Turnstile → site key do `config.js` (`TURNSTILE_SITE_KEY`), secret key do Supabase **Authentication → Attack Protection**.
- **Ďalšie dieťa (migrácia `…_dalsie_dieta.sql`):** po potvrdení sa prevezmú zákonní zástupcovia, osoby na vyzdvihnutie a núdzové kontakty z prvého dieťaťa.
- **Odovzdanie vedenia:** Používatelia → Odovzdať vedenie. Riaditeľka s vlastnou triedou má prepínač Moja trieda / Správa škôlky.
- **Dochádzka (migrácia `…_dochadzka_potvrdenie.sql`):** trieda je mriežka polí. Červené = odhlásené/chýba, zelené = potvrdené učiteľkou, oranžové = nespracované (po 8:00 sa ťuknutím otvoria možnosti).
- Kuchyňa: výber alergénov v jedálničku a tlač denného zoznamu. Rodič: vyhlásenie o bezinfekčnosti v Neprítomnosti.

## Pravidlá zo školského poriadku

- **Strava sa odhlasuje do 8:00 v deň neprítomnosti.** Uzávierku stráži databáza v triggeri `absences_before_insert`, takže ju nedá obísť ani upravený klient. Pole `meals_from` hovorí, od ktorého dňa je strava odhlásená. Z neho sa počítajú porcie pre kuchyňu (`meal_counts`).
- Odhlásenie sa dá zrušiť len vtedy, ak ešte neprebehla uzávierka jeho prvého dňa.
- Pri neprítomnosti 5 a viac dní platforma pripomenie vyhlásenie o bezinfekčnosti, nad 7 dní potvrdenie od lekára.
- Oprávnenú osobu na vyzdvihnutie pridá rodič. Platná je až vtedy, keď učiteľka potvrdí písomné splnomocnenie.

## Kto čo vidí (RLS)

| Rola | Vidí | Môže |
|---|---|---|
| Rodič | svoje deti, oznamy ich tried a celej MŠ, mená učiteliek | odhlásiť dieťa, písať správy, potvrdiť oznam, hlasovať, pridať osobu na vyzdvihnutie a núdzové kontakty |
| Učiteľka | všetky deti a triedy (kvôli záskokom) | dochádzka aj spätne, odhlásenie za rodiča, oznamy (úprava a mazanie vlastných), správy, potvrdenie splnomocnení |
| Riaditeľka (`admin`) | všetko | navyše schvaľovanie, zamietnutie a deaktivácia účtov, zmena rolí, správa detí a rodičov, triedy učiteliek, suplovanie, výkaz dochádzky (CSV za zvolený mesiac) a jedálny lístok |
| Kuchyňa | len počty porcií podľa triedy, bez mien detí | jedálny lístok |

## Zdravotné údaje (vypnuté)

Formulár pre alergie, ochorenia, lieky a diéty je hotový, ale **vypnutý**. Kým je vypnutý, databáza tieto údaje nevydá ani neprijme, aj keby ich klient poslal. Keď bude GDPR vyriešené (zmluva a informovanie rodičov), zapni ho v SQL Editore:
```sql
update settings set value = true where key = 'health_enabled';
```
Potom rodič vyplní údaje v karte dieťaťa. Učiteľky a vedenie ich vidia pri dieťati, kuchyňa vidí len počet diét v triede bez mien.

## Zámerne vynechané (ďalšie kroky)

- **Platby.** Okno pre rodičov je pripravené a prázdne. Doplnia sa platby škôlka, kuchyňa, ZRPŠ a ďalšie po dohode.
- **Fotogaléria** a **offline režim** (service worker zatiaľ obsluhuje len push).
- **Zabudnuté heslo** funguje až s nastaveným SMTP (krok 5). Dovtedy heslo resetuješ v **Authentication → Users**. Prihlásený používateľ si heslo zmení sám cez **Menu → Zmeniť heslo** hore.

## GDPR pred spustením

- [ ] Zmluva o spracúvaní osobných údajov medzi škôlkou alebo mestom (prevádzkovateľ) a tebou (sprostredkovateľ)
- [ ] Informácia pre rodičov: čo sa ukladá, kto to vidí a ako dlho
- [ ] Supabase v EÚ regióne a akceptovaná DPA od Supabase
- [ ] Po odchode dieťaťa nastaviť `children.active = false` a do 30 dní dieťa zmazať (zmažú sa aj jeho odhlásenia, správy a podobne)
