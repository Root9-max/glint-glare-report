// config.js
// ---------------------------------------------------------
// Fill these in with YOUR OWN Supabase project details.
// Get them from: Supabase dashboard → Settings → API
//
// SUPABASE_URL   → "Project URL"
// SUPABASE_ANON  → "anon public" key (NOT the service_role key —
//                   never put the service_role key in frontend code)
//
// The anon key is safe to expose in client-side code as long as
// Row Level Security (RLS) is enabled on your tables — see
// supabase-setup.sql for the policies that make this safe.
// ---------------------------------------------------------

const SUPABASE_URL = "https://myzyytyqnncgbrdappqm.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15enl5dHlxbm5jZ2JyZGFwcHFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5OTIwMjgsImV4cCI6MjA5ODU2ODAyOH0.fKlyWy4pPPIJstSX1uyY6kTn4zznCQ30atoMQ084rOY";

// Creates a client if credentials look filled in; otherwise leaves
// window.db as null so the rest of the app can run without a database
// (results just won't be saved).
window.db = null;

if (
  typeof supabase !== "undefined" &&
  SUPABASE_URL.startsWith("http") &&
  SUPABASE_ANON.length > 20
) {
  window.db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
}