// Verejné hodnoty, patria do repozitára. Tajný (secret/service_role) kľúč sem nikdy nedávaj.
export const SUPABASE_URL = 'https://TVOJ-PROJEKT.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_...'   // Supabase → Project Settings → API Keys → Publishable key
export const VAPID_PUBLIC_KEY = 'BAt1drkn-WdicUe4Au5edtVi36S3SFvd0y6kLNAyZoRIK4yCVT_Sz0ZgzqDZtdQ8TcwwrhDVi-dKq3mmFGTgxwo'                  // z `npx web-push generate-vapid-keys` (Public Key); prázdne = bez push