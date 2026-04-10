import { createClient } from "@supabase/supabase-js";

const url     = process.env.SUPABASE_URL!;
const anon    = process.env.SUPABASE_ANON_KEY!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anon || !service) {
  throw new Error("Variáveis SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.");
}

/**
 * Cliente admin (service role).
 * Usa para operações que precisam bypassar RLS (ex: criar workspace inicial).
 * NUNCA envie essa chave para o frontend ou mobile.
 */
export const supabaseAdmin = createClient(url, service, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Retorna um cliente autenticado com o JWT do usuário.
 * Respeita RLS automaticamente — use esse na maioria das rotas.
 */
export function supabaseForUser(accessToken: string) {
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });
}
