import fs from "node:fs";
import path from "node:path";
import type { CustomModelConfig } from "./catalog.ts";
import type { Locale } from "./lang.ts";

/**
 * Short UI labels ("Sign in", "Home") are the most common i18n strings and the
 * hardest for a sentence-level MT model: with no context it picks the wrong sense
 * ("Sign in" -> "Signification"). Standard platform terminology is used instead.
 *
 * Only whole-string matches are replaced. Projects can override any entry.
 */
const LANGS = ["fr", "es", "de", "it", "pt-BR", "nl", "ar"] as const;

// prettier-ignore
const TABLE: Record<string, [string, string, string, string, string, string, string]> = {
  //                  fr                             es                              de                          it                             pt-BR                        nl                         ar
  "sign in":         ["Se connecter",                "Iniciar sesión",               "Anmelden",                 "Accedi",                      "Entrar",                    "Inloggen",                "تسجيل الدخول"],
  "log in":          ["Se connecter",                "Iniciar sesión",               "Anmelden",                 "Accedi",                      "Entrar",                    "Inloggen",                "تسجيل الدخول"],
  "login":           ["Connexion",                   "Iniciar sesión",               "Anmelden",                 "Accedi",                      "Entrar",                    "Inloggen",                "تسجيل الدخول"],
  "sign up":         ["S'inscrire",                  "Registrarse",                  "Registrieren",             "Registrati",                  "Cadastrar-se",              "Registreren",             "إنشاء حساب"],
  "register":        ["S'inscrire",                  "Registrarse",                  "Registrieren",             "Registrati",                  "Cadastrar-se",              "Registreren",             "إنشاء حساب"],
  "sign out":        ["Se déconnecter",              "Cerrar sesión",                "Abmelden",                 "Esci",                        "Sair",                      "Uitloggen",               "تسجيل الخروج"],
  "log out":         ["Se déconnecter",              "Cerrar sesión",                "Abmelden",                 "Esci",                        "Sair",                      "Uitloggen",               "تسجيل الخروج"],
  "logout":          ["Déconnexion",                 "Cerrar sesión",                "Abmelden",                 "Esci",                        "Sair",                      "Uitloggen",               "تسجيل الخروج"],
  "home":            ["Accueil",                     "Inicio",                       "Startseite",               "Home",                        "Início",                    "Home",                    "الرئيسية"],
  "settings":        ["Paramètres",                  "Configuración",                "Einstellungen",            "Impostazioni",                "Configurações",             "Instellingen",            "الإعدادات"],
  "profile":         ["Profil",                      "Perfil",                       "Profil",                   "Profilo",                     "Perfil",                    "Profiel",                 "الملف الشخصي"],
  "account":         ["Compte",                      "Cuenta",                       "Konto",                    "Account",                     "Conta",                     "Account",                 "الحساب"],
  "dashboard":       ["Tableau de bord",             "Panel",                        "Dashboard",                "Dashboard",                   "Painel",                    "Dashboard",               "لوحة التحكم"],
  "shop":            ["Boutique",                    "Tienda",                       "Shop",                     "Negozio",                     "Loja",                      "Winkel",                  "المتجر"],
  "cart":            ["Panier",                      "Carrito",                      "Warenkorb",                "Carrello",                    "Carrinho",                  "Winkelwagen",             "السلة"],
  "add to cart":     ["Ajouter au panier",           "Añadir al carrito",            "In den Warenkorb",         "Aggiungi al carrello",        "Adicionar ao carrinho",     "In winkelwagen",          "أضف إلى السلة"],
  "notifications":   ["Notifications",               "Notificaciones",               "Benachrichtigungen",       "Notifiche",                   "Notificações",              "Meldingen",               "الإشعارات"],
  "language":        ["Langue",                      "Idioma",                       "Sprache",                  "Lingua",                      "Idioma",                    "Taal",                    "اللغة"],
  "help":            ["Aide",                        "Ayuda",                        "Hilfe",                    "Aiuto",                       "Ajuda",                     "Help",                    "المساعدة"],
  "save":            ["Enregistrer",                 "Guardar",                      "Speichern",                "Salva",                       "Salvar",                    "Opslaan",                 "حفظ"],
  "cancel":          ["Annuler",                     "Cancelar",                     "Abbrechen",                "Annulla",                     "Cancelar",                  "Annuleren",               "إلغاء"],
  "delete":          ["Supprimer",                   "Eliminar",                     "Löschen",                  "Elimina",                     "Excluir",                   "Verwijderen",             "حذف"],
  "edit":            ["Modifier",                    "Editar",                       "Bearbeiten",               "Modifica",                    "Editar",                    "Bewerken",                "تعديل"],
  "search":          ["Rechercher",                  "Buscar",                       "Suchen",                   "Cerca",                       "Pesquisar",                 "Zoeken",                  "بحث"],
  "submit":          ["Envoyer",                     "Enviar",                       "Absenden",                 "Invia",                       "Enviar",                    "Verzenden",               "إرسال"],
  "send":            ["Envoyer",                     "Enviar",                       "Senden",                   "Invia",                       "Enviar",                    "Verzenden",               "إرسال"],
  "next":            ["Suivant",                     "Siguiente",                    "Weiter",                   "Avanti",                      "Próximo",                   "Volgende",                "التالي"],
  "back":            ["Retour",                      "Atrás",                        "Zurück",                   "Indietro",                    "Voltar",                    "Terug",                   "رجوع"],
  "previous":        ["Précédent",                   "Anterior",                     "Zurück",                   "Precedente",                  "Anterior",                  "Vorige",                  "السابق"],
  "close":           ["Fermer",                      "Cerrar",                       "Schließen",                "Chiudi",                      "Fechar",                    "Sluiten",                 "إغلاق"],
  "continue":        ["Continuer",                   "Continuar",                    "Weiter",                   "Continua",                    "Continuar",                 "Doorgaan",                "متابعة"],
  "confirm":         ["Confirmer",                   "Confirmar",                    "Bestätigen",               "Conferma",                    "Confirmar",                 "Bevestigen",              "تأكيد"],
  "yes":             ["Oui",                         "Sí",                           "Ja",                       "Sì",                          "Sim",                       "Ja",                      "نعم"],
  "no":              ["Non",                         "No",                           "Nein",                     "No",                          "Não",                       "Nee",                     "لا"],
  "ok":              ["OK",                          "Aceptar",                      "OK",                       "OK",                          "OK",                        "OK",                      "حسنًا"],
  "done":            ["Terminé",                     "Listo",                        "Fertig",                   "Fatto",                       "Concluído",                 "Klaar",                   "تم"],
  "apply":           ["Appliquer",                   "Aplicar",                      "Anwenden",                 "Applica",                     "Aplicar",                   "Toepassen",               "تطبيق"],
  "reset":           ["Réinitialiser",               "Restablecer",                  "Zurücksetzen",             "Reimposta",                   "Redefinir",                 "Resetten",                "إعادة تعيين"],
  "retry":           ["Réessayer",                   "Reintentar",                   "Erneut versuchen",         "Riprova",                     "Tentar novamente",          "Opnieuw proberen",        "إعادة المحاولة"],
  "add":             ["Ajouter",                     "Añadir",                       "Hinzufügen",               "Aggiungi",                    "Adicionar",                 "Toevoegen",               "إضافة"],
  "remove":          ["Retirer",                     "Quitar",                       "Entfernen",                "Rimuovi",                     "Remover",                   "Verwijderen",             "إزالة"],
  "update":          ["Mettre à jour",               "Actualizar",                   "Aktualisieren",            "Aggiorna",                    "Atualizar",                 "Bijwerken",               "تحديث"],
  "upload":          ["Importer",                    "Subir",                        "Hochladen",                "Carica",                      "Enviar",                    "Uploaden",                "رفع"],
  "download":        ["Télécharger",                 "Descargar",                    "Herunterladen",            "Scarica",                     "Baixar",                    "Downloaden",              "تنزيل"],
  "share":           ["Partager",                    "Compartir",                    "Teilen",                   "Condividi",                   "Compartilhar",              "Delen",                   "مشاركة"],
  "copy":            ["Copier",                      "Copiar",                       "Kopieren",                 "Copia",                       "Copiar",                    "Kopiëren",                "نسخ"],
  "filter":          ["Filtrer",                     "Filtrar",                      "Filtern",                  "Filtra",                      "Filtrar",                   "Filteren",                "تصفية"],
  "sort by":         ["Trier par",                   "Ordenar por",                  "Sortieren nach",           "Ordina per",                  "Ordenar por",               "Sorteren op",             "ترتيب حسب"],
  "show more":       ["Afficher plus",               "Mostrar más",                  "Mehr anzeigen",            "Mostra di più",               "Mostrar mais",              "Meer weergeven",          "عرض المزيد"],
  "show less":       ["Afficher moins",              "Mostrar menos",                "Weniger anzeigen",         "Mostra meno",                 "Mostrar menos",             "Minder weergeven",        "عرض أقل"],
  "view all":        ["Tout afficher",               "Ver todo",                     "Alle anzeigen",            "Vedi tutto",                  "Ver tudo",                  "Alles bekijken",          "عرض الكل"],
  "learn more":      ["En savoir plus",              "Más información",              "Mehr erfahren",            "Scopri di più",               "Saiba mais",                "Meer informatie",         "معرفة المزيد"],
  "get started":     ["Commencer",                   "Empezar",                      "Loslegen",                 "Inizia",                      "Começar",                   "Aan de slag",             "ابدأ الآن"],
  "contact us":      ["Nous contacter",              "Contáctanos",                  "Kontakt",                  "Contattaci",                  "Fale conosco",              "Contact",                 "اتصل بنا"],
  "privacy policy":  ["Politique de confidentialité", "Política de privacidad",      "Datenschutzerklärung",     "Informativa sulla privacy",   "Política de Privacidade",   "Privacybeleid",           "سياسة الخصوصية"],
  "terms of service":["Conditions d'utilisation",    "Términos del servicio",        "Nutzungsbedingungen",      "Termini di servizio",         "Termos de Serviço",         "Servicevoorwaarden",      "شروط الخدمة"],
  "email":           ["E-mail",                      "Correo electrónico",           "E-Mail",                   "Email",                       "E-mail",                    "E-mail",                  "البريد الإلكتروني"],
  "password":        ["Mot de passe",                "Contraseña",                   "Passwort",                 "Password",                    "Senha",                     "Wachtwoord",              "كلمة المرور"],
  "username":        ["Nom d'utilisateur",           "Nombre de usuario",            "Benutzername",             "Nome utente",                 "Nome de usuário",           "Gebruikersnaam",          "اسم المستخدم"],
  "forgot password?":["Mot de passe oublié ?",   "¿Olvidaste tu contraseña?",    "Passwort vergessen?",      "Password dimenticata?",       "Esqueceu a senha?",         "Wachtwoord vergeten?",    "هل نسيت كلمة المرور؟"],
  "loading":         ["Chargement",                  "Cargando",                     "Wird geladen",             "Caricamento",                 "Carregando",                "Laden",                   "جارٍ التحميل"],
  "today":           ["Aujourd'hui",                 "Hoy",                          "Heute",                    "Oggi",                        "Hoje",                      "Vandaag",                 "اليوم"],
  "yesterday":       ["Hier",                        "Ayer",                         "Gestern",                  "Ieri",                        "Ontem",                     "Gisteren",                "أمس"],
};

export interface ProjectConfig {
  /** Terms copied verbatim (brand and product names). */
  doNotTranslate?: string[];
  /**
   * Key paths copied verbatim, dot/`[i]` notation ("brand.name", "config.statusEnum").
   * Protects an enum array, or a field whose text a model might otherwise respell
   * or inflect, without enumerating every value "doNotTranslate" would need.
   */
  doNotTranslateKeys?: string[];
  /** Exact-string overrides per target locale: { "fr": { "Home": "Accueil" } }. */
  glossary?: Record<string, Record<string, string>>;
  /** Extra translation models (local folders or Hugging Face repos). */
  models?: CustomModelConfig[];
  /** Folder of the config file (set by loadConfig; relative model paths resolve from here). */
  dir?: string;
  /** Absolute path of the config file actually found and read, if any (set by loadConfig; absent when none exists). */
  configFile?: string;
}

export const CONFIG_FILE = "locale-ai.config.json";

/**
 * Walks up from `dir` looking for `locale-ai.config.json`, the same way
 * eslint/prettier find their own config — so running from a subdirectory (or
 * with `--input ../locales` pointing elsewhere) still finds a config.json
 * sitting at the project root instead of silently skipping `doNotTranslate`/
 * `glossary` and picking a different lockfile location than a run from the
 * root would. Stops at the first directory holding `.git` (checking that
 * directory itself first) so it never wanders into an unrelated ancestor
 * project, and otherwise stops at the filesystem root.
 */
function findConfigUp(dir: string): string | undefined {
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, ".git"))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readConfigFile(p: string): ProjectConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as ProjectConfig;
    if (cfg.doNotTranslate && !Array.isArray(cfg.doNotTranslate)) throw new Error('"doNotTranslate" must be an array');
    if (cfg.doNotTranslateKeys && !Array.isArray(cfg.doNotTranslateKeys)) throw new Error('"doNotTranslateKeys" must be an array');
    if (cfg.models && !Array.isArray(cfg.models)) throw new Error('"models" must be an array');
    return { ...cfg, dir: path.dirname(p), configFile: p };
  } catch (e) {
    throw new Error(`Invalid ${path.basename(p)}: ${(e as Error).message}`);
  }
}

export function loadConfig(cwd: string, file?: string): ProjectConfig {
  if (file) {
    const p = path.resolve(cwd, file);
    if (!fs.existsSync(p)) throw new Error(`Config file not found: ${file}`);
    return readConfigFile(p);
  }
  const p = findConfigUp(cwd);
  return p ? readConfigFile(p) : { dir: cwd };
}

function builtinColumn(target: Locale): number {
  if (target.lang === "pt") return target.region === "PT" ? -1 : LANGS.indexOf("pt-BR");
  return LANGS.indexOf(target.lang as (typeof LANGS)[number]);
}

const normalizeKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Returns a lookup for whole strings: project glossary first, then the built-in
 * UI terms (English sources only). Keeps surrounding whitespace, trailing
 * ellipsis/colon and ALL-CAPS styling of the source.
 */
export function glossaryLookup(
  source: Locale,
  target: Locale,
  config: ProjectConfig,
): (s: string) => string | undefined {
  const project = new Map<string, string>();
  for (const key of [target.lang, target.tag]) {
    for (const [k, v] of Object.entries(config.glossary?.[key] ?? {})) project.set(normalizeKey(k), v);
  }
  const column = source.lang === "en" ? builtinColumn(target) : -1;

  return (s: string) => {
    const m = /^(\s*)(.*?)(\s*(?:…|\.\.\.|:)?\s*)$/s.exec(s)!;
    const [, lead, core, tail] = m;
    if (!core) return undefined;
    const hit = project.get(normalizeKey(s)) ?? project.get(normalizeKey(core));
    if (hit !== undefined) return project.has(normalizeKey(s)) ? hit : lead + hit + tail;
    if (column < 0) return undefined;
    const row = TABLE[normalizeKey(core)];
    if (!row) return undefined;
    let value = row[column];
    const letters = core.replace(/[^\p{L}]/gu, "");
    if (letters.length > 1 && letters === letters.toUpperCase()) value = value.toLocaleUpperCase(target.lang);
    let t = tail;
    // French puts a non-breaking space before ":" (so it can't wrap onto its own line);
    // the term itself already handles "?".
    if (target.lang === "fr" && /^:/.test(t.trim())) t = t.replace(/^\s*:/, " :");
    return lead + value + t;
  };
}

/** Regex matching do-not-translate terms as whole words, or undefined. */
export function protectRegex(config: ProjectConfig): RegExp | undefined {
  const terms = (config.doNotTranslate ?? []).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return undefined;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "u");
}
