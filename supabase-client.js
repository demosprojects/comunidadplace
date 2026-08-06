// ============================================================
// CONFIGURACIÓN DE SUPABASE
// ============================================================
// 1. Andá a supabase.com -> tu proyecto -> Project Settings -> API
// 2. Copiá "Project URL" y "anon public key" acá abajo.
// ============================================================
// Se usa "var" (no "const") a propósito: si este archivo por error queda
// incluido dos veces en el mismo HTML, "var" no rompe la página (una
// segunda declaración con "const" sí tira SyntaxError y frena todo el script).
var SUPABASE_URL = "https://zlqzsxyhyfrmmhzwfikj.supabase.co";
var SUPABASE_ANON_KEY = "sb_publishable_eMPALOR2u8FrIrKM2NMRVA_zXKYaV9o";

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------
// VISITOR ID (para favoritos sin necesidad de cuenta)
// ------------------------------------------------------------
function obtenerVisitorId() {
    let vid = localStorage.getItem('cp_visitor_id');
    if (!vid) {
        vid = crypto.randomUUID();
        localStorage.setItem('cp_visitor_id', vid);
    }
    return vid;
}

// ------------------------------------------------------------
// HELPERS DE SESIÓN
// ------------------------------------------------------------
async function obtenerSesion() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

// Devuelve la fila de `usuarios` (con rol) del usuario logueado, o null
async function obtenerPerfilUsuario() {
    const session = await obtenerSesion();
    if (!session) return null;
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('id', session.user.id)
        .single();
    if (error) {
        console.error('Error obteniendo perfil de usuario:', error);
        return null;
    }
    return data;
}

// Protege una página: si no hay sesión (o no tiene el rol pedido) redirige a login.html
async function requerirSesion(rolRequerido) {
    const perfil = await obtenerPerfilUsuario();
    if (!perfil) {
        window.location.href = 'login.html';
        return null;
    }
    if (rolRequerido && perfil.rol !== rolRequerido) {
        alert('No tenés permiso para acceder a esta sección.');
        window.location.href = 'index.html';
        return null;
    }
    return perfil;
}

async function cerrarSesion() {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
}

// Formatea precio en pesos
function formatoPrecio(n) {
    return '$' + Number(n).toLocaleString('es-AR');
}

// ------------------------------------------------------------
// REALTIME: cambios instantáneos sin recargar la página
// ------------------------------------------------------------
// IMPORTANTE: para que esto funcione hay que habilitar Realtime en
// Supabase para cada tabla que se quiera escuchar:
//   Supabase Dashboard -> Database -> Replication -> activar
//   "emprendedores", "categorias" y "productos".
// Si no se activa ahí, el código no tira error pero nunca van a
// llegar los eventos (los cambios solo se van a ver al recargar).

// Se suscribe a INSERT/UPDATE/DELETE de una tabla y ejecuta "callback"
// cada vez que ocurre algo. "filtro" es opcional, ej: 'emprendedor_id=eq.123'
function suscribirTabla(tabla, callback, filtro) {
    const config = { event: '*', schema: 'public', table: tabla };
    if (filtro) config.filter = filtro;
    const nombreCanal = `rt-${tabla}-${filtro || 'all'}-${Math.random().toString(36).slice(2, 8)}`;
    return supabase
        .channel(nombreCanal)
        .on('postgres_changes', config, callback)
        .subscribe();
}

// Si suben varios productos/emprendedores casi al mismo tiempo, esto evita
// disparar la misma recarga muchas veces seguidas: espera a que se calmen
// los eventos y recién ahí ejecuta "fn" una sola vez.
function debounce(fn, espera = 350) {
    let temporizador = null;
    return (...args) => {
        clearTimeout(temporizador);
        temporizador = setTimeout(() => fn(...args), espera);
    };
}