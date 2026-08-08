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

// Foto que se usa cuando un emprendedor no sube una imagen propia para su
// producto, para que nunca quede un espacio vacío/roto en la tienda.
const IMAGEN_PRODUCTO_DEFAULT = "https://zlqzsxyhyfrmmhzwfikj.supabase.co/storage/v1/object/public/productos-imagenes/ea99f2f0-a86c-4317-bd3d-9514ae78044d/1786157133417-xx42cg.webp";

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
        mostrarToast('No tenés permiso para acceder a esta sección.', 'error');
        setTimeout(() => { window.location.href = 'index.html'; }, 1600);
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
// MEDIOS DE PAGO (catálogo fijo, compartido entre el dashboard
// del emprendedor y la tienda pública)
// ------------------------------------------------------------
const MEDIOS_PAGO = [
    { id: 'efectivo',      label: 'Efectivo',            icon: '💵' },
    { id: 'transferencia', label: 'Transferencia',       icon: '🏦' },
    { id: 'mercadopago',   label: 'Mercado Pago',        icon: '💳' },
    { id: 'debito',        label: 'Tarjeta de débito',   icon: '💳' },
    { id: 'credito',       label: 'Tarjeta de crédito',  icon: '💳' },
];

function nombreMedioPago(id) {
    const m = MEDIOS_PAGO.find(m => m.id === id);
    return m ? m.label : id;
}

function iconoMedioPago(id) {
    const m = MEDIOS_PAGO.find(m => m.id === id);
    return m ? m.icon : '💰';
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

// ============================================================
// UI KIT: toasts y modal de confirmación
// ============================================================
// Reemplazo de alert()/confirm() nativos del navegador. Se inyectan
// solos (estilos + contenedor) la primera vez que se cargan en la
// página, así que no hace falta tocar el HTML de cada página para
// poder usarlos.
(function initUIKit() {
    if (document.getElementById('cp-uikit-styles')) return;

    const style = document.createElement('style');
    style.id = 'cp-uikit-styles';
    style.textContent = `
        .cp-toast-container {
            position: fixed; top: 1rem; right: 1rem; z-index: 9999;
            display: flex; flex-direction: column; gap: 0.5rem;
            max-width: min(360px, calc(100vw - 2rem));
        }
        .cp-toast {
            display: flex; align-items: flex-start; gap: 0.6rem;
            padding: 0.85rem 1rem; border-radius: 14px;
            font-family: inherit, sans-serif; font-size: 0.8rem; font-weight: 600;
            color: #fff; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.3);
            animation: cp-toast-in 0.25s cubic-bezier(0.16,1,0.3,1);
            line-height: 1.4;
        }
        .cp-toast.error { background: #dc2626; }
        .cp-toast.success { background: #059669; }
        .cp-toast.info { background: #0b0c10; }
        .cp-toast button {
            background: none; border: none; color: inherit; opacity: 0.7;
            cursor: pointer; font-size: 0.9rem; line-height: 1; padding: 0;
            margin-left: auto; flex-shrink: 0;
        }
        .cp-toast button:hover { opacity: 1; }
        @keyframes cp-toast-in { from { opacity:0; transform: translateX(16px);} to {opacity:1; transform:translateX(0);} }
        @keyframes cp-toast-out { from {opacity:1;} to {opacity:0; transform: translateX(16px);} }

        .cp-confirm-overlay {
            position: fixed; inset: 0; z-index: 9998;
            background: rgba(11,12,16,0.7); backdrop-filter: blur(6px);
            display: flex; align-items: center; justify-content: center;
            padding: 1rem; animation: cp-fade-in 0.2s ease;
        }
        @keyframes cp-fade-in { from {opacity:0;} to {opacity:1;} }
        .cp-confirm-box {
            background: #fff; width: 100%; max-width: 380px; border-radius: 24px;
            padding: 1.75rem; font-family: inherit, sans-serif;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.4);
        }
        .cp-confirm-title { font-weight: 800; font-size: 1.1rem; color: #0f172a; margin: 0 0 0.4rem; }
        .cp-confirm-msg { font-size: 0.85rem; color: #64748b; font-weight: 500; line-height: 1.5; margin: 0 0 1.5rem; }
        .cp-confirm-actions { display: flex; gap: 0.75rem; }
        .cp-confirm-actions button {
            flex: 1; padding: 0.85rem; border-radius: 12px; font-weight: 800;
            font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
            border: none; cursor: pointer; transition: all 0.15s;
        }
        .cp-confirm-cancel { background: #f1f5f9; color: #64748b; }
        .cp-confirm-cancel:hover { background: #e2e8f0; }
        .cp-confirm-ok { background: #0b0c10; color: #fff; }
        .cp-confirm-ok:hover { background: #facc15; color: #000; }
        .cp-confirm-ok.peligro { background: #dc2626; }
        .cp-confirm-ok.peligro:hover { background: #b91c1c; }
    `;
    document.head.appendChild(style);

    const contenedorToasts = document.createElement('div');
    contenedorToasts.className = 'cp-toast-container';
    contenedorToasts.id = 'cp-toast-container';
    document.body.appendChild(contenedorToasts);
})();

// Muestra una notificación flotante (reemplaza alert()).
// tipo: 'error' | 'success' | 'info'
function mostrarToast(mensaje, tipo = 'error', duracion = 4000) {
    const cont = document.getElementById('cp-toast-container');
    if (!cont) return;

    const toast = document.createElement('div');
    toast.className = `cp-toast ${tipo}`;

    const texto = document.createElement('span');
    texto.textContent = mensaje;

    const btnCerrar = document.createElement('button');
    btnCerrar.setAttribute('aria-label', 'Cerrar');
    btnCerrar.textContent = '✕';

    toast.append(texto, btnCerrar);

    const quitar = () => {
        toast.style.animation = 'cp-toast-out 0.2s ease forwards';
        setTimeout(() => toast.remove(), 200);
    };
    btnCerrar.addEventListener('click', quitar);

    cont.appendChild(toast);
    setTimeout(quitar, duracion);
}

// Modal de confirmación (reemplaza confirm()). Devuelve una Promise<boolean>.
// Uso: const ok = await confirmarAccion('¿Seguro?', { titulo: '...', textoConfirmar: 'Eliminar' });
function confirmarAccion(mensaje, opciones = {}) {
    const {
        titulo = '¿Estás seguro?',
        textoConfirmar = 'Confirmar',
        textoCancelar = 'Cancelar',
        peligro = true,
    } = opciones;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cp-confirm-overlay';

        const box = document.createElement('div');
        box.className = 'cp-confirm-box';

        const pTitulo = document.createElement('p');
        pTitulo.className = 'cp-confirm-title';
        pTitulo.textContent = titulo;

        const pMsg = document.createElement('p');
        pMsg.className = 'cp-confirm-msg';
        pMsg.textContent = mensaje;

        const acciones = document.createElement('div');
        acciones.className = 'cp-confirm-actions';

        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'cp-confirm-cancel';
        btnCancelar.textContent = textoCancelar;

        const btnOk = document.createElement('button');
        btnOk.type = 'button';
        btnOk.className = `cp-confirm-ok ${peligro ? 'peligro' : ''}`;
        btnOk.textContent = textoConfirmar;

        acciones.append(btnCancelar, btnOk);
        box.append(pTitulo, pMsg, acciones);
        overlay.appendChild(box);

        const cerrar = (resultado) => { overlay.remove(); resolve(resultado); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(false); });
        btnCancelar.addEventListener('click', () => cerrar(false));
        btnOk.addEventListener('click', () => cerrar(true));

        document.body.appendChild(overlay);
    });
}
