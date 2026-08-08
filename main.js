let productos = [];        // productos ya traídos de Supabase (con joins)
let categoriasDB = [];
let visitorId = null;
let productoModalActual = null;
let variantesModalActual = [];
let seleccionVariantes = {}; // { nombreGrupo: {valor, precio_adicional} }
let cantidadModalActual = 1;
let mediosPagoModalActual = []; // medios de pago del producto/tienda abiertos en el modal actual

// Filtros activos (paneles desplegables de categoría / emprendedor / orden)
let categoriaActivaId = 'Todos';
let categoriaActivaLabel = 'Todas';
let tiendaActivaId = 'Todos';
let tiendaActivaLabel = 'Todos';
let ordenActivo = 'recientes';
let ordenActivoLabel = 'Más recientes';

// ------------------------------------------------------------
// CARRITO (un solo emprendedor por carrito)
// ------------------------------------------------------------
const CARRITO_STORAGE_KEY = 'cp_carrito_v1';
let carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', items: [] };
let itemPendienteConflicto = null; // item que se intentó agregar y disparó el conflicto de tienda

document.addEventListener('DOMContentLoaded', async () => {
    // Si se entra desde el link directo de un producto (?producto=ID),
    // el splash ya se mostró al instante desde el <script> inline en el
    // <head>/<body>; acá lo "registramos" en el sistema de bloqueo de
    // scroll y lo dejamos pendiente para abrir el modal más abajo.
    const params = new URLSearchParams(window.location.search);
    const productoIdDesdeLink = params.get('producto');
    if (productoIdDesdeLink) mostrarSplashScreen();

    try {
        visitorId = obtenerVisitorId();
    } catch (e) {
        console.error('Error generando visitorId:', e);
        // Fallback que no depende de crypto.randomUUID (falla en contextos
        // no seguros, p.ej. http:// por IP local en el celular en vez de https/localhost)
        visitorId = 'visitor_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        try { localStorage.setItem('cp_visitor_id', visitorId); } catch (e2) { /* localStorage no disponible */ }
    }

    cargarCarritoDesdeStorage();

    // Promise.allSettled: si una carga falla, las demás igual se completan y se muestran.
    const resultados = await Promise.allSettled([cargarCategorias(), cargarEmprendedoresFila()]);
    resultados.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.error(['cargarCategorias', 'cargarEmprendedoresFila'][i] + ' falló:', r.reason);
        }
    });

    try {
        await cargarProductos();
    } catch (e) {
        console.error('Error cargando productos:', e);
        const cont = document.getElementById('contenedor-productos');
        if (cont) {
            cont.innerHTML = `<p class="col-span-full text-center py-10 text-red-400 italic">No se pudieron cargar los productos. Revisá la conexión con Supabase (consola del navegador para más detalle).</p>`;
        }
    }
    aplicarFiltros();

    // Si mientras el carrito estaba guardado (localStorage) el emprendedor
    // desactivó algún producto o su tienda, lo marcamos como no disponible
    // acá, antes de que el usuario pueda llegar a comprarlo.
    sincronizarDisponibilidadCarrito();

    // Recién con el catálogo cargado buscamos el producto del link y
    // abrimos su modal; recién ahí se oculta el splash.
    if (productoIdDesdeLink) await abrirProductoDesdeLink(productoIdDesdeLink);

    iniciarRealtime();

    let debounceBusquedaTimeout = null;
    document.getElementById('buscador').addEventListener('input', () => {
        clearTimeout(debounceBusquedaTimeout);
        const texto = document.getElementById('buscador').value.trim();
        actualizarBotonLimpiarBusqueda();
        if (texto === '') {
            // Borraron todo el texto: el catálogo vuelve a mostrarse
            // completo (respetando los otros filtros que sigan activos).
            cerrarSugerenciasBusqueda();
            aplicarFiltros();
            return;
        }
        // Mostramos el skeleton AL INSTANTE (no espera el debounce), así
        // el usuario ve que el buscador reaccionó apenas tipeó una letra.
        mostrarSkeletonBusqueda();
        debounceBusquedaTimeout = setTimeout(() => {
            // Mientras escribe, SOLO se actualiza el panel de sugerencias.
            // El catálogo de abajo no se toca: no salta de tamaño y
            // si un producto no aparece en las sugerencias es porque
            // no existe, sin necesidad de mirar más abajo.
            mostrarSugerenciasBusqueda();
        }, 500);
    });

    // Si ya hay texto tipeado y el usuario vuelve a tocar el input,
    // reabrimos el panel de sugerencias en vez de dejarlo cerrado.
    document.getElementById('buscador').addEventListener('focus', () => {
        if (document.getElementById('buscador').value.trim() !== '') mostrarSugerenciasBusqueda();
    });

    document.getElementById('buscador').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cerrarSugerenciasBusqueda();
            document.getElementById('buscador').blur();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            verTodosResultadosBusqueda();
        }
    });

    document.addEventListener('click', (e) => {
        ['categoria', 'emprendedor', 'orden'].forEach(tipo => {
            if (!e.target.closest(`#btn-filtro-${tipo}`) && !e.target.closest(`#panel-filtro-${tipo}`)) {
                cerrarFiltroPanel(tipo);
            }
        });
        if (!e.target.closest('#buscador') && !e.target.closest('#buscador-sugerencias')) {
            cerrarSugerenciasBusqueda();
        }
    });

    window.addEventListener('resize', () => {
        ['categoria', 'emprendedor', 'orden'].forEach(tipo => {
            const panel = document.getElementById(`panel-filtro-${tipo}`);
            if (panel && !panel.classList.contains('hidden')) posicionarPanelFiltro(panel);
        });
    });
});

// ============================================================
// SPLASH SCREEN (entrada desde el link directo de un producto)
// ============================================================
function mostrarSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    splash.classList.remove('hidden', 'splash-oculto');
    // bloquearScrollBody lleva la cuenta de bloqueos activos: si después
    // también se abre el modal del producto, el scroll queda bloqueado
    // sin cortes hasta que el usuario cierre ese modal.
    bloquearScrollBody();
}

function ocultarSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (!splash || splash.classList.contains('hidden')) return;
    splash.classList.add('splash-oculto');
    desbloquearScrollBody();
    setTimeout(() => splash.classList.add('hidden'), 500);
}

// Busca el producto del link (?producto=ID), le abre el modal de detalle
// y recién ahí hace desaparecer el splash. Si no existe (borrado, pausado
// o el catálogo no cargó), oculta el splash igual y avisa con un toast.
async function abrirProductoDesdeLink(id) {
    const existe = productos.find(p => p.id === id);
    if (existe) {
        await verDetalles(id);
        ocultarSplashScreen();
    } else {
        ocultarSplashScreen();
        mostrarToastCarrito('No pudimos abrir ese producto');
    }
}

// ============================================================
// CARGA DE DATOS
// ============================================================
async function cargarCategorias() {
    const { data, error } = await supabase.from('categorias').select('*').order('nombre');
    if (error) { console.error(error); return; }
    categoriasDB = data;

    const panel = document.getElementById('panel-filtro-categoria');
    // Sacamos las opciones cargadas dinámicamente antes de reconstruir
    // (dejamos el botón fijo "Todos" que ya está en el HTML).
    panel.querySelectorAll('.opcion-categoria:not([data-categoria="Todos"])').forEach(b => b.remove());
    data.forEach(c => {
        const btn = document.createElement('button');
        btn.className = "opcion-categoria w-full flex items-center justify-between text-left px-4 py-2.5 rounded-xl font-bold text-sm uppercase hover:bg-yellow-50 transition-colors";
        btn.dataset.categoria = c.id;
        btn.innerHTML = `<span class="truncate">${escapeHtml(c.nombre)}</span><span class="check text-yellow-500 font-black hidden">✓</span>`;
        btn.addEventListener('click', () => seleccionarCategoriaFiltro(btn, c.id, c.nombre));
        panel.appendChild(btn);
    });
    marcarOpcionActivaEnPanel(panel, '.opcion-categoria', 'categoria', categoriaActivaId);
}

// Después de reconstruir un panel de filtro (por un cambio en tiempo real),
// vuelve a marcar visualmente cuál era la opción seleccionada.
function marcarOpcionActivaEnPanel(panel, selector, atributoData, valorActivo) {
    panel.querySelectorAll(selector).forEach(b => {
        const activo = String(b.dataset[atributoData]) === String(valorActivo);
        b.classList.toggle('bg-black', activo);
        b.classList.toggle('text-white', activo);
        const check = b.querySelector('.check');
        if (check) check.classList.toggle('hidden', !activo);
    });
}

// ============================================================
// PANELES DE FILTRO (categoría / emprendedor / orden)
// ============================================================
function toggleFiltroPanel(tipo) {
    const panel = document.getElementById(`panel-filtro-${tipo}`);
    const abierto = !panel.classList.contains('hidden');
    ['categoria', 'emprendedor', 'orden'].forEach(cerrarFiltroPanel);
    if (!abierto) {
        panel.classList.remove('hidden');
        const chevron = document.getElementById(`chevron-${tipo}`);
        if (chevron) chevron.classList.add('rotate-180');
        posicionarPanelFiltro(panel);
    }
}

function cerrarFiltroPanel(tipo) {
    document.getElementById(`panel-filtro-${tipo}`).classList.add('hidden');
    const chevron = document.getElementById(`chevron-${tipo}`);
    if (chevron) chevron.classList.remove('rotate-180');
}

// Evita que el panel se salga de la pantalla en mobile: si al abrirse
// se corta por el borde derecho o izquierdo, lo reancla del lado que
// corresponda en vez de dejarlo desbordado/cortado.
function posicionarPanelFiltro(panel) {
    panel.style.left = '0';
    panel.style.right = 'auto';
    const margen = 12;
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth - margen) {
        panel.style.left = 'auto';
        panel.style.right = '0';
    }
    const rectFlip = panel.getBoundingClientRect();
    if (rectFlip.left < margen) {
        panel.style.left = '0';
        panel.style.right = 'auto';
    }
}

function seleccionarCategoriaFiltro(btnSeleccionado, id, nombre) {
    categoriaActivaId = id;
    categoriaActivaLabel = nombre;
    document.getElementById('label-filtro-categoria').innerText = nombre;
    document.querySelectorAll('.opcion-categoria').forEach(b => {
        b.classList.remove('bg-black', 'text-white');
        b.querySelector('.check').classList.add('hidden');
    });
    btnSeleccionado.classList.add('bg-black', 'text-white');
    btnSeleccionado.querySelector('.check').classList.remove('hidden');
    cerrarFiltroPanel('categoria');
    actualizarBotonLimpiarFiltros();
    aplicarFiltros();
}

function seleccionarEmprendedorFiltro(btnSeleccionado, id, nombre) {
    tiendaActivaId = id;
    tiendaActivaLabel = nombre;
    document.getElementById('label-filtro-emprendedor').innerText = nombre;
    document.querySelectorAll('.opcion-emprendedor').forEach(b => {
        b.classList.remove('bg-black', 'text-white');
        b.querySelector('.check').classList.add('hidden');
    });
    btnSeleccionado.classList.add('bg-black', 'text-white');
    btnSeleccionado.querySelector('.check').classList.remove('hidden');
    cerrarFiltroPanel('emprendedor');
    actualizarBotonLimpiarFiltros();
    aplicarFiltros();
}

function seleccionarOrdenFiltro(btnSeleccionado, valor, nombre) {
    ordenActivo = valor;
    ordenActivoLabel = nombre;
    document.getElementById('label-filtro-orden').innerText = nombre;
    document.querySelectorAll('.opcion-orden').forEach(b => {
        b.classList.remove('bg-black', 'text-white');
        b.querySelector('.check').classList.add('hidden');
    });
    btnSeleccionado.classList.add('bg-black', 'text-white');
    btnSeleccionado.querySelector('.check').classList.remove('hidden');
    cerrarFiltroPanel('orden');
    aplicarFiltros();
}

function actualizarBotonLimpiarFiltros() {
    const btn = document.getElementById('btn-limpiar-filtros');
    const hayFiltros = categoriaActivaId !== 'Todos' || tiendaActivaId !== 'Todos';
    btn.classList.toggle('hidden', !hayFiltros);
    btn.classList.toggle('flex', hayFiltros);
}

async function cargarEmprendedoresFila() {
    const { data, error } = await supabase
        .from('emprendedores')
        .select('id, nombre_tienda, logo_url')
        .eq('activo', true)
        .order('nombre_tienda');
    if (error) { console.error(error); return; }

    // --- Fila de logos debajo del banner (abre el perfil del emprendedor) ---
    const cont = document.getElementById('emprendedores-fila');
    if (cont) {
        cont.innerHTML = data.length === 0 ? '' : data.map(e => {
            const inicial = e.nombre_tienda ? e.nombre_tienda.charAt(0).toUpperCase() : '?';
            const avatar = e.logo_url
                ? `<img src="${e.logo_url}" alt="${escapeHtml(e.nombre_tienda)}" class="w-12 h-12 sm:w-16 sm:h-16 rounded-full object-cover ring-2 ring-gray-100 group-hover:ring-yellow-400 transition-all">`
                : `<span class="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-black text-white flex items-center justify-center text-base sm:text-xl font-900 ring-2 ring-gray-100 group-hover:ring-yellow-400 transition-all">${escapeHtml(inicial)}</span>`;
            return `
                <button onclick="abrirPerfilEmprendedor('${e.id}')" class="group flex flex-col items-center gap-1.5 sm:gap-2 flex-shrink-0 w-16 sm:w-20 text-center">
                    ${avatar}
                    <span class="text-[8px] sm:text-[10px] font-bold uppercase tracking-widest text-gray-600 group-hover:text-black transition-colors truncate w-full">${escapeHtml(e.nombre_tienda)}</span>
                </button>
            `;
        }).join('');
    }

    // --- Panel del filtro "Emprendedor" (logo + nombre) ---
    const panel = document.getElementById('panel-filtro-emprendedor');
    if (panel) {
        panel.querySelectorAll('.opcion-emprendedor:not([data-emprendedor="Todos"])').forEach(b => b.remove());
        data.forEach(e => {
            const inicial = e.nombre_tienda ? e.nombre_tienda.charAt(0).toUpperCase() : '?';
            const avatar = e.logo_url
                ? `<img src="${e.logo_url}" alt="${escapeHtml(e.nombre_tienda)}" class="w-8 h-8 rounded-full object-cover flex-shrink-0">`
                : `<span class="w-8 h-8 rounded-full bg-gray-200 text-black flex items-center justify-center text-xs font-black flex-shrink-0">${escapeHtml(inicial)}</span>`;
            const btn = document.createElement('button');
            btn.className = "opcion-emprendedor w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl font-bold text-sm uppercase hover:bg-yellow-50 transition-colors";
            btn.dataset.emprendedor = e.id;
            btn.innerHTML = `${avatar}<span class="flex-1 truncate">${escapeHtml(e.nombre_tienda)}</span><span class="check text-yellow-500 font-black hidden">✓</span>`;
            btn.addEventListener('click', () => seleccionarEmprendedorFiltro(btn, e.id, e.nombre_tienda));
            panel.appendChild(btn);
        });
        marcarOpcionActivaEnPanel(panel, '.opcion-emprendedor', 'emprendedor', tiendaActivaId);
    }
}

// ============================================================
// TIEMPO REAL: escucha cambios en Supabase y refresca la vitrina sola
// ============================================================
function iniciarRealtime() {
    // Nuevo producto, editado, borrado, activado/ocultado -> refresca la grilla
    const refrescarProductos = debounce(async () => {
        await cargarProductos();
        aplicarFiltros();
        // Si el producto que se acaba de ocultar/borrar estaba en el
        // carrito de alguien que sigue navegando, lo marcamos como no
        // disponible al toque (no se saca solo, ver sincronizarDisponibilidadCarrito).
        sincronizarDisponibilidadCarrito();
    }, 350);

    // Nuevo emprendedor, bloqueado/activado, o editó su perfil (nombre/logo)
    // -> refresca la fila de logos, el panel de filtro y las cards (usan esos datos)
    const refrescarEmprendedores = debounce(async () => {
        await cargarEmprendedoresFila();
        await cargarProductos();
        aplicarFiltros();
        // Si la tienda se desactivó, sus productos quedan marcados como no
        // disponibles en el carrito de quien los tuviera cargados.
        sincronizarDisponibilidadCarrito();
    }, 350);

    // Categoría nueva/borrada/renombrada -> refresca el panel y las cards
    const refrescarCategorias = debounce(async () => {
        await cargarCategorias();
        await cargarProductos();
        aplicarFiltros();
    }, 350);

    // Si el emprendedor edita stock/precio de una variante mientras alguien
    // tiene el modal de ese producto abierto, se actualiza sin recargar.
    const refrescarVariantesModal = debounce(async () => {
        if (!productoModalActual) return;
        const modal = document.getElementById('modal-producto');
        if (!modal.classList.contains('abierto')) return;
        const { data: variantes, error } = await supabase.from('variantes').select('*').eq('producto_id', productoModalActual.id);
        if (error) return;
        variantesModalActual = variantes;
        renderVariantesModal();
        actualizarPrecioYWhatsapp();
    }, 350);

    suscribirTabla('productos', refrescarProductos);
    suscribirTabla('emprendedores', refrescarEmprendedores);
    suscribirTabla('categorias', refrescarCategorias);
    suscribirTabla('variantes', refrescarVariantesModal);
}

async function cargarProductos() {
    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, banner_url, bio, ubicacion, mapa_url, horario_atencion, instagram, facebook, tiktok, medios_pago, usuarios(usuario))')
        .eq('activo', true)
        .eq('emprendedores.activo', true)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        document.getElementById('contenedor-productos').innerHTML =
            `<p class="col-span-full text-center py-10 text-red-400 italic">No se pudieron cargar los productos. Revisá la conexión con Supabase.</p>`;
        return;
    }
    productos = data;
    precargarImagenesProductos();
}

// Dispara la descarga de todas las fotos de producto en segundo plano,
// sin esperar a que terminen (no usa await), para que ya estén en la
// caché del navegador cuando el usuario busque. Funciona sin importar
// dónde esté alojada cada imagen (Cloudinary, Supabase Storage, etc).
function precargarImagenesProductos() {
    productos.forEach(p => {
        if (!p.imagen_url) return;
        const img = new Image();
        img.src = p.imagen_url;
    });
}

// ============================================================
// RENDER DE CARDS
// ============================================================
function mostrarProductos(lista) {
    const contenedor = document.getElementById('contenedor-productos');
    contenedor.innerHTML = "";

    if (lista.length === 0) {
        contenedor.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center text-center py-20">
                <span class="text-4xl mb-4">🔍</span>
                <p class="text-gray-500 font-bold">No encontramos productos con esos filtros.</p>
                <p class="text-gray-400 text-sm mt-1">Probá con otra categoría, tienda o búsqueda.</p>
                <button onclick="limpiarFiltros()" class="mt-6 border-2 border-black px-6 py-2.5 rounded-full font-bold uppercase text-xs tracking-widest hover:bg-black hover:text-white transition-all active:scale-95">
                    Limpiar filtros
                </button>
            </div>`;
        return;
    }

    contenedor.innerHTML = lista.map(p => {
        const esNuevo = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) < (7 * 24 * 60 * 60 * 1000) : false;
        const tienda = p.emprendedores ? p.emprendedores.nombre_tienda : '';
        const logoTienda = p.emprendedores ? p.emprendedores.logo_url : '';
        const inicialTienda = tienda ? tienda.charAt(0).toUpperCase() : '?';
        const avatarTienda = logoTienda
            ? `<img src="${logoTienda}" alt="${escapeHtml(tienda)}" class="w-4 h-4 sm:w-6 sm:h-6 rounded-full object-cover flex-shrink-0 ring-1 ring-black/5">`
            : `<span class="w-4 h-4 sm:w-6 sm:h-6 rounded-full bg-yellow-400 text-black text-[7px] sm:text-[10px] font-black flex items-center justify-center flex-shrink-0">${escapeHtml(inicialTienda)}</span>`;
        return `
            <div class="group cursor-pointer h-full flex flex-col bg-white rounded-2xl sm:rounded-3xl lg:rounded-2xl border border-gray-100 shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300 overflow-hidden animate-fade-in" onclick="verDetalles('${p.id}')">
                <div class="relative aspect-[4/5] lg:aspect-[4/3] overflow-hidden bg-gray-50 flex-shrink-0 flex items-center justify-center">
                    <img src="${p.imagen_url || ''}" alt="${escapeHtml(p.nombre)}" class="w-full h-full object-contain p-3 sm:p-5 lg:p-3.5 transition duration-300">
                    <div class="absolute top-1.5 sm:top-3 lg:top-2 left-1.5 sm:left-3 lg:left-2 flex gap-1 sm:gap-1.5">
                        ${esNuevo ? `<span class="bg-yellow-400 text-black text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest">Nuevo</span>` : ''}
                        <span class="bg-white/90 backdrop-blur text-black text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest truncate max-w-[70px] sm:max-w-none">${p.categorias ? escapeHtml(p.categorias.nombre) : 'General'}</span>
                    </div>
                </div>
                <div class="p-2.5 sm:p-5 lg:p-3.5 flex flex-col flex-1">
                    <button onclick="event.stopPropagation(); abrirPerfilEmprendedor('${p.emprendedores ? p.emprendedores.id : ''}')"
                        class="flex items-center gap-1.5 sm:gap-2 lg:gap-1.5 mb-1.5 sm:mb-2 lg:mb-1 -ml-1 pl-1 pr-2.5 py-0.5 sm:py-1 rounded-full hover:bg-yellow-50 transition-colors group/tienda w-full text-left flex-shrink-0">
                        ${avatarTienda}
                        <span class="text-gray-500 text-[8px] sm:text-[10px] font-bold uppercase tracking-widest group-hover/tienda:text-black truncate flex-1 transition-colors">${escapeHtml(tienda)}</span>
                        <span class="hidden sm:inline text-gray-300 group-hover/tienda:text-yellow-600 group-hover/tienda:translate-x-0.5 transition-all text-xs flex-shrink-0">›</span>
                    </button>
                    <h3 class="font-black text-xs sm:text-lg lg:text-sm leading-snug group-hover:text-yellow-600 transition-colors min-h-[2.4em] sm:min-h-[2.6em] lg:min-h-[2.4em] line-clamp-2">${escapeHtml(p.nombre)}</h3>
                    <div class="flex items-center justify-between mt-auto pt-2 sm:pt-4 lg:pt-2">
                        <span class="font-900 text-sm sm:text-xl lg:text-base">${formatoPrecio(p.precio)}</span>
                        <span class="w-7 h-7 sm:w-10 sm:h-10 lg:w-8 lg:h-8 rounded-full bg-black text-white flex items-center justify-center text-xs sm:text-sm group-hover:bg-yellow-400 group-hover:text-black transition-all active:scale-90 flex-shrink-0">→</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function limpiarFiltros() {
    document.getElementById('buscador').value = '';
    actualizarBotonLimpiarBusqueda();
    cerrarSugerenciasBusqueda();

    categoriaActivaId = 'Todos';
    categoriaActivaLabel = 'Todas';
    tiendaActivaId = 'Todos';
    tiendaActivaLabel = 'Todos';
    ordenActivo = 'recientes';
    ordenActivoLabel = 'Más recientes';
    document.getElementById('label-filtro-categoria').innerText = 'Todas';
    document.getElementById('label-filtro-emprendedor').innerText = 'Todos';
    document.getElementById('label-filtro-orden').innerText = 'Recientes';

    document.querySelectorAll('.opcion-categoria').forEach(b => {
        const esTodos = b.dataset.categoria === 'Todos';
        b.classList.toggle('bg-black', esTodos);
        b.classList.toggle('text-white', esTodos);
        b.querySelector('.check').classList.toggle('hidden', !esTodos);
    });
    document.querySelectorAll('.opcion-emprendedor').forEach(b => {
        const esTodos = b.dataset.emprendedor === 'Todos';
        b.classList.toggle('bg-black', esTodos);
        b.classList.toggle('text-white', esTodos);
        b.querySelector('.check').classList.toggle('hidden', !esTodos);
    });
    document.querySelectorAll('.opcion-orden').forEach(b => {
        const esRecientes = b.dataset.orden === 'recientes';
        b.classList.toggle('bg-black', esRecientes);
        b.classList.toggle('text-white', esRecientes);
        b.querySelector('.check').classList.toggle('hidden', !esRecientes);
    });
    actualizarBotonLimpiarFiltros();
    aplicarFiltros();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// Pide a Cloudinary una versión chica y optimizada de la imagen (para
// miniaturas como las del dropdown de búsqueda), en vez de bajar la
// imagen completa del producto solo para mostrarla en 40x40px.
// Si la URL no es de Cloudinary, la devuelve sin tocar.
function miniaturaCloudinary(url, size = 60) {
    if (!url) return '';
    const marcador = '/upload/';
    const i = url.indexOf(marcador);
    if (i === -1) return url; // no es una URL de Cloudinary, se usa tal cual
    const inicio = i + marcador.length;
    return url.slice(0, inicio) + `w_${size},h_${size},c_fill,q_auto,f_auto/` + url.slice(inicio);
}

// ============================================================
// FILTROS (categoría + tienda + búsqueda)
// ============================================================
function aplicarFiltros() {
    const textoBusqueda = document.getElementById('buscador').value.toLowerCase();

    let filtrados = productos;

    if (categoriaActivaId !== 'Todos') {
        filtrados = filtrados.filter(p => String(p.categoria_id) === String(categoriaActivaId));
    }
    if (tiendaActivaId !== 'Todos') {
        filtrados = filtrados.filter(p => p.emprendedor_id === tiendaActivaId);
    }
    if (textoBusqueda !== '') {
        filtrados = filtrados.filter(p =>
            p.nombre.toLowerCase().includes(textoBusqueda) ||
            (p.emprendedores && p.emprendedores.nombre_tienda.toLowerCase().includes(textoBusqueda))
        );
    }
    filtrados = [...filtrados]; // no mutar el array original de productos
    if (ordenActivo === 'precio-asc') {
        filtrados.sort((a, b) => Number(a.precio) - Number(b.precio));
    } else if (ordenActivo === 'precio-desc') {
        filtrados.sort((a, b) => Number(b.precio) - Number(a.precio));
    } else if (ordenActivo === 'nombre') {
        filtrados.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    } else {
        filtrados.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    mostrarProductos(filtrados);
}

// ============================================================
// SUGERENCIAS EN VIVO DEL BUSCADOR (dropdown bajo el input)
// ============================================================
const MAX_SUGERENCIAS_BUSQUEDA = 6;
const ICONO_FLECHA_SVG = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;

// Muestra u oculta la X de "limpiar" según haya texto o no en el input.
function actualizarBotonLimpiarBusqueda() {
    const texto = document.getElementById('buscador').value;
    document.getElementById('buscador-clear').classList.toggle('hidden', texto === '');
}

function limpiarBusqueda() {
    const input = document.getElementById('buscador');
    input.value = '';
    actualizarBotonLimpiarBusqueda();
    cerrarSugerenciasBusqueda();
    aplicarFiltros();
    input.focus();
}

// Envuelve en <mark> la parte del texto que coincide con lo buscado,
// para que salte a la vista por qué apareció ese resultado.
function resaltarCoincidencia(textoOriginal, queryOriginal) {
    const texto = escapeHtml(textoOriginal ?? '');
    const query = escapeHtml((queryOriginal ?? '').trim());
    if (!query) return texto;
    const idx = texto.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return texto;
    return texto.slice(0, idx)
        + '<mark class="bg-yellow-200 text-black rounded-sm">' + texto.slice(idx, idx + query.length) + '</mark>'
        + texto.slice(idx + query.length);
}

// Bloques grises "pulsando" que se muestran al instante mientras se
// resuelve la búsqueda, para que quede claro que el buscador está
// procesando y no que se quedó pegado.
function mostrarSkeletonBusqueda() {
    const cont = document.getElementById('buscador-sugerencias');
    const fila = `
        <div class="w-full flex items-center gap-3 px-3.5 py-3 animate-pulse">
            <div class="w-11 h-11 rounded-xl bg-gray-200 flex-shrink-0"></div>
            <div class="flex-1 min-w-0 space-y-1.5">
                <div class="h-3 bg-gray-200 rounded w-3/4"></div>
                <div class="h-2 bg-gray-100 rounded w-1/3"></div>
            </div>
            <div class="h-3 w-10 bg-gray-200 rounded flex-shrink-0"></div>
        </div>`;
    cont.innerHTML = `<div class="divide-y divide-gray-50">${fila.repeat(3)}</div>`;
    cont.classList.remove('hidden');
}

function mostrarSugerenciasBusqueda() {
    const cont = document.getElementById('buscador-sugerencias');
    const inputEl = document.getElementById('buscador');
    const textoOriginal = inputEl.value.trim();
    const texto = textoOriginal.toLowerCase();

    if (texto === '') {
        cerrarSugerenciasBusqueda();
        return;
    }

    const coincidencias = productos.filter(p =>
        p.nombre.toLowerCase().includes(texto) ||
        (p.emprendedores && p.emprendedores.nombre_tienda.toLowerCase().includes(texto))
    );

    if (coincidencias.length === 0) {
        cont.innerHTML = `
            <div class="px-6 py-8 text-center">
                <svg class="w-8 h-8 mx-auto text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                </svg>
                <p class="text-sm text-gray-600 font-bold">Sin resultados para "${escapeHtml(textoOriginal)}"</p>
                <p class="text-xs text-gray-400 mt-1">Probá con otra palabra o revisá cómo lo escribiste.</p>
            </div>`;
        cont.classList.remove('hidden');
        return;
    }

    const paraMostrar = coincidencias.slice(0, MAX_SUGERENCIAS_BUSQUEDA);

    const filas = paraMostrar.map(p => {
        const tienda = p.emprendedores ? p.emprendedores.nombre_tienda : '';
        return `
            <button onclick="irADetalleDesdeBusqueda('${p.id}')" class="group/sug w-full flex items-center gap-3 px-3.5 py-3 hover:bg-yellow-50 transition-colors text-left">
                <img src="${miniaturaCloudinary(p.imagen_url)}" alt="${escapeHtml(p.nombre)}" class="w-11 h-11 rounded-xl object-cover flex-shrink-0 bg-gray-50 opacity-0 transition-opacity duration-200" loading="lazy" onload="this.classList.remove('opacity-0')" onerror="this.classList.remove('opacity-0'); this.style.display='none'">
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm truncate">${resaltarCoincidencia(p.nombre, textoOriginal)}</p>
                    <p class="text-[10px] text-gray-400 uppercase tracking-widest truncate mt-0.5">${resaltarCoincidencia(tienda, textoOriginal)}</p>
                </div>
                <span class="font-black text-sm flex-shrink-0">${formatoPrecio(p.precio)}</span>
                <span class="text-gray-300 group-hover/sug:text-yellow-500 group-hover/sug:translate-x-0.5 transition-all flex-shrink-0">${ICONO_FLECHA_SVG}</span>
            </button>`;
    }).join('');

    const footer = `
        <button onclick="verTodosResultadosBusqueda()" class="w-full flex items-center justify-center gap-1.5 py-3 bg-gray-50/70 font-bold text-xs uppercase tracking-widest text-yellow-600 hover:bg-yellow-50 transition-colors">
            Ver ${coincidencias.length === 1 ? 'el' : 'los'} ${coincidencias.length} resultado${coincidencias.length === 1 ? '' : 's'}
            ${ICONO_FLECHA_SVG}
        </button>`;

    cont.innerHTML = `<div class="divide-y divide-gray-50">${filas}</div>` + footer;
    cont.classList.remove('hidden');
}

function irADetalleDesdeBusqueda(id) {
    cerrarSugerenciasBusqueda();
    verDetalles(id);
}

function verTodosResultadosBusqueda() {
    cerrarSugerenciasBusqueda();
    aplicarFiltros(); // recién acá el catálogo se filtra por el texto buscado
    const destino = document.getElementById('contenedor-productos');
    if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cerrarSugerenciasBusqueda() {
    const cont = document.getElementById('buscador-sugerencias');
    cont.classList.add('hidden');
    cont.innerHTML = '';
}

// ============================================================
// MODAL DE DETALLE + VARIANTES
// ============================================================
async function verDetalles(id) {
    const p = productos.find(item => item.id === id);
    if (!p) return;
    productoModalActual = p;
    seleccionVariantes = {};
    cantidadModalActual = 1;
    document.getElementById('modal-cantidad').innerText = '1';

    document.getElementById('modal-img').src = p.imagen_url || '';
    document.getElementById('modal-nombre').innerText = p.nombre;
    const modalTienda = document.getElementById('modal-tienda');
    modalTienda.innerText = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    modalTienda.onclick = () => abrirPerfilEmprendedor(p.emprendedores ? p.emprendedores.id : '');
    document.getElementById('modal-desc').innerText = p.descripcion || 'Sin descripción disponible.';

    renderMediosPagoModal(p);

    const { data: variantes, error } = await supabase.from('variantes').select('*').eq('producto_id', id);
    variantesModalActual = error ? [] : variantes;

    renderVariantesModal();
    actualizarPrecioYWhatsapp();

    document.getElementById('modal-producto-overlay').classList.add('abierto');
    document.getElementById('modal-producto').classList.add('abierto');
    bloquearScrollBody();
}

function renderVariantesModal() {
    const cont = document.getElementById('modal-variantes');
    if (variantesModalActual.length === 0) { cont.innerHTML = ''; return; }

    const grupos = {};
    variantesModalActual.forEach(v => {
        if (!grupos[v.nombre]) grupos[v.nombre] = [];
        grupos[v.nombre].push(v);
    });

    cont.innerHTML = Object.entries(grupos).map(([nombreGrupo, opciones]) => {
        if (!seleccionVariantes[nombreGrupo]) {
            seleccionVariantes[nombreGrupo] = { valor: opciones[0].valor, precio_adicional: opciones[0].precio_adicional };
        }
        return `
            <div>
                <p class="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">${escapeHtml(nombreGrupo)}</p>
                <div class="flex flex-wrap gap-2">
                    ${opciones.map(o => `
                        <button type="button"
                            onclick="seleccionarVariante('${nombreGrupo.replace(/'/g, "\\'")}', '${o.valor.replace(/'/g, "\\'")}', ${o.precio_adicional || 0})"
                            class="variante-opcion px-4 py-2 rounded-full border-2 text-xs font-bold uppercase transition-all ${o.valor === seleccionVariantes[nombreGrupo].valor ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-200 hover:border-black'}"
                            data-grupo="${escapeHtml(nombreGrupo)}" data-valor="${escapeHtml(o.valor)}">
                            ${escapeHtml(o.valor)}${o.precio_adicional > 0 ? ' (+' + formatoPrecio(o.precio_adicional) + ')' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function seleccionarVariante(grupo, valor, precioAdicional) {
    seleccionVariantes[grupo] = { valor, precio_adicional: precioAdicional };
    renderVariantesModal();
    actualizarPrecioYWhatsapp();
}

function actualizarPrecioYWhatsapp() {
    const p = productoModalActual;
    if (!p) return;

    const extra = Object.values(seleccionVariantes).reduce((sum, v) => sum + (Number(v.precio_adicional) || 0), 0);
    const precioFinal = Number(p.precio) + extra;
    document.getElementById('modal-precio').innerText = formatoPrecio(precioFinal);

    const detalleVariantes = Object.entries(seleccionVariantes)
        .map(([grupo, v]) => `${grupo}: ${v.valor}`)
        .join(', ');

    const tienda = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    const whatsapp = p.emprendedores ? p.emprendedores.whatsapp : '';
    let msg = `Hola ${tienda}, vi tu producto "${p.nombre}" en ComunidadPlace y quiero más info!`;
    if (detalleVariantes) msg += ` (${detalleVariantes})`;

    const linkWhatsapp = document.getElementById('modal-whatsapp');
    if (whatsapp) {
        linkWhatsapp.href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(msg)}`;
        linkWhatsapp.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        linkWhatsapp.href = '#';
        linkWhatsapp.classList.add('opacity-40', 'pointer-events-none');
    }
}

function renderMediosPagoModal(p) {
    const wrap = document.getElementById('modal-medios-pago-wrap');

    // Si el producto tiene medios propios, se usan esos; si no, se muestran
    // todos los que configuró la tienda.
    const mediosProducto = p.medios_pago && p.medios_pago.length > 0
        ? p.medios_pago
        : (p.emprendedores ? (p.emprendedores.medios_pago || []) : []);

    mediosPagoModalActual = mediosProducto;

    if (mediosProducto.length === 0) {
        wrap.classList.add('hidden');
        return;
    }

    wrap.classList.remove('hidden');
}

// Modal secundario: lista de medios de pago disponibles para el producto
// abierto. Se muestra encima del modal de producto para no alargarlo en mobile.
function abrirModalMediosPago() {
    const cont = document.getElementById('modal-medios-pago-lista');
    cont.innerHTML = mediosPagoModalActual.map(id => `
        <span class="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-200 px-3 py-1.5 rounded-full text-xs font-semibold text-gray-700">
            <span>${iconoMedioPago(id)}</span><span>${escapeHtml(nombreMedioPago(id))}</span>
        </span>
    `).join('');
    document.getElementById('modal-medios-pago-modal').classList.remove('hidden');
    bloquearScrollBody();
}

function cerrarModalMediosPago() {
    document.getElementById('modal-medios-pago-modal').classList.add('hidden');
    desbloquearScrollBody();
}

function cerrarModal() {
    // Si el modal de medios de pago quedó abierto encima, lo cerramos primero
    // para no dejar el contador de bloqueo de scroll desincronizado.
    const modalMediosPago = document.getElementById('modal-medios-pago-modal');
    if (modalMediosPago && !modalMediosPago.classList.contains('hidden')) {
        cerrarModalMediosPago();
    }

    document.getElementById('modal-producto-overlay').classList.remove('abierto');
    document.getElementById('modal-producto').classList.remove('abierto');
    desbloquearScrollBody();
    productoModalActual = null;
}

// ============================================================
// BLOQUEO DE SCROLL DEL FONDO (a prueba de iOS Safari)
// overflow:hidden solo en el body no alcanza en iOS: el scroll
// "sangra" hacia el contenido de atrás al arrastrar dentro del
// modal. Fijar el body con position:fixed lo evita del todo.
// ============================================================
let _scrollYGuardado = 0;
let _cantidadModalesAbiertos = 0;

function bloquearScrollBody() {
    if (_cantidadModalesAbiertos === 0) {
        _scrollYGuardado = window.scrollY;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${_scrollYGuardado}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.overflow = 'hidden';
    }
    _cantidadModalesAbiertos++;
}

function desbloquearScrollBody() {
    _cantidadModalesAbiertos = Math.max(0, _cantidadModalesAbiertos - 1);
    if (_cantidadModalesAbiertos === 0) {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        window.scrollTo(0, _scrollYGuardado);
    }
}

// ============================================================
// MODAL DE PERFIL DEL EMPRENDEDOR
// ============================================================
async function abrirPerfilEmprendedor(emprendedorId) {
    if (!emprendedorId) return;

    // Buscamos los datos del emprendedor entre los productos ya cargados
    // (todos vienen con el join a "emprendedores", así que no hace falta pedirlos de nuevo)
    const productoConDatos = productos.find(p => p.emprendedores && p.emprendedores.id === emprendedorId);
    let e = productoConDatos ? productoConDatos.emprendedores : null;

    // Si el emprendedor todavía no tiene productos cargados, no aparece en
    // "productos" -> lo buscamos directo en Supabase para poder mostrar su perfil igual.
    if (!e) {
        const { data, error } = await supabase
            .from('emprendedores')
            .select('*, usuarios(usuario)')
            .eq('id', emprendedorId)
            .eq('activo', true)
            .single();
        if (error || !data) return;
        e = data;
    }

    // Banner de fondo (opcional)
    const bannerWrap = document.getElementById('perfil-banner-wrap');
    const bannerImg = document.getElementById('perfil-banner');
    if (e.banner_url) {
        if (bannerImg.src === e.banner_url && bannerImg.complete) {
            // Es la misma imagen que ya está cargada (ej: reabrís el mismo
            // emprendedor): la mostramos directo, no hay nada que esperar.
            bannerWrap.classList.remove('hidden');
        } else {
            // Ocultamos el banner viejo ANTES de pisar el src, para no
            // mostrar por un instante la foto del emprendedor anterior
            // mientras se descarga la nueva.
            bannerWrap.classList.add('hidden');
            bannerImg.onload = () => bannerWrap.classList.remove('hidden');
            bannerImg.onerror = () => bannerWrap.classList.add('hidden');
            bannerImg.src = e.banner_url;
        }
    } else {
        bannerImg.removeAttribute('src');
        bannerWrap.classList.add('hidden');
    }

    const logo = document.getElementById('perfil-logo');
    const logoPlaceholder = document.getElementById('perfil-logo-placeholder');
    if (e.logo_url) {
        logo.src = e.logo_url;
        logo.classList.remove('hidden');
        logoPlaceholder.classList.add('hidden');
        logoPlaceholder.classList.remove('flex');
    } else {
        logoPlaceholder.textContent = (e.nombre_tienda || '?').charAt(0).toUpperCase();
        logoPlaceholder.classList.remove('hidden');
        logoPlaceholder.classList.add('flex');
        logo.classList.add('hidden');
    }

    document.getElementById('perfil-nombre').innerText = e.nombre_tienda || '';
    document.getElementById('perfil-bio').innerText = e.bio || 'Este emprendedor todavía no cargó una descripción.';

    const cantidadProductos = productos.filter(p => p.emprendedores && p.emprendedores.id === emprendedorId).length;
    document.getElementById('perfil-cantidad').innerText = cantidadProductos > 0
        ? `${cantidadProductos} producto${cantidadProductos === 1 ? '' : 's'} en la comunidad`
        : 'Todavía sin productos cargados';

    // Ubicación + horario (solo se muestran si están cargados)
    const ubicacionWrap = document.getElementById('perfil-ubicacion-wrap');
    if (e.ubicacion) {
        document.getElementById('perfil-ubicacion').innerText = e.ubicacion;
        ubicacionWrap.classList.remove('hidden');
        ubicacionWrap.classList.add('inline-flex');
    } else {
        ubicacionWrap.classList.add('hidden');
        ubicacionWrap.classList.remove('inline-flex');
    }
    const horarioWrap = document.getElementById('perfil-horario-wrap');
    if (e.horario_atencion) {
        document.getElementById('perfil-horario').innerText = e.horario_atencion;
        horarioWrap.classList.remove('hidden');
        horarioWrap.classList.add('inline-flex');
    } else {
        horarioWrap.classList.add('hidden');
        horarioWrap.classList.remove('inline-flex');
    }

    // Redes sociales (solo se muestran las que están cargadas)
    configurarRedSocialPerfil('perfil-instagram', e.instagram);
    configurarRedSocialPerfil('perfil-facebook', e.facebook);
    configurarRedSocialPerfil('perfil-tiktok', e.tiktok);

    const btnWsp = document.getElementById('perfil-whatsapp');
    if (e.whatsapp) {
        const msg = `Hola ${e.nombre_tienda}, te encontré en ComunidadPlace!`;
        btnWsp.href = `https://wa.me/${e.whatsapp}?text=${encodeURIComponent(msg)}`;
        btnWsp.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        btnWsp.href = '#';
        btnWsp.classList.add('opacity-40', 'pointer-events-none');
    }

    // El botón siempre lleva al perfil completo del emprendedor; el texto
    // cambia según si ya tiene productos publicados o no.
    const textoBtnVerProductos = document.getElementById('perfil-ver-productos-texto');
    if (textoBtnVerProductos) {
        textoBtnVerProductos.textContent = cantidadProductos > 0 ? 'Ver sus productos' : 'Ver perfil';
    }
    const btnVerProductos = document.getElementById('perfil-ver-productos');
    const slugTienda = e.usuarios && e.usuarios.usuario;
    btnVerProductos.onclick = () => {
        window.location.href = slugTienda
            ? `emprendedor.html?t=${encodeURIComponent(slugTienda)}`
            : `emprendedor.html?id=${encodeURIComponent(emprendedorId)}`; // fallback por si todavía no tiene "usuario" cargado
    };

    document.getElementById('modal-perfil').classList.remove('hidden');
    bloquearScrollBody();
}

function cerrarPerfilEmprendedor() {
    document.getElementById('modal-perfil').classList.add('hidden');
    desbloquearScrollBody();
}

function configurarRedSocialPerfil(elementId, url) {
    const link = document.getElementById(elementId);
    if (!link) return;
    if (url) {
        link.href = url;
        link.classList.remove('hidden');
        link.classList.add('flex');
    } else {
        link.classList.add('hidden');
        link.classList.remove('flex');
    }
}

// ============================================================
// CARRITO (un solo emprendedor por carrito, checkout por WhatsApp)
// ============================================================
function cargarCarritoDesdeStorage() {
    try {
        const guardado = localStorage.getItem(CARRITO_STORAGE_KEY);
        if (guardado) carrito = JSON.parse(guardado);
    } catch (e) { console.error('No se pudo leer el carrito guardado', e); }
    actualizarBadgeCarrito();
}

function guardarCarritoEnStorage() {
    localStorage.setItem(CARRITO_STORAGE_KEY, JSON.stringify(carrito));
}

// Marca (sin eliminar) los productos del carrito que ya no figuran en el
// catálogo activo (el emprendedor los ocultó/borró, o desactivó su tienda
// entera). El producto se queda en el carrito con un aviso de "no
// disponible" y el botón de enviar pedido queda bloqueado: el usuario
// tiene que eliminarlo a mano para poder seguir comprando.
// `productos` siempre refleja lo que está activo AHORA (se recarga por
// realtime y al iniciar), así que compararlo contra el carrito guardado
// es suficiente para detectar productos que se volvieron no disponibles
// mientras estaban en el carrito de alguien.
function sincronizarDisponibilidadCarrito(mostrarAviso = true) {
    if (carrito.items.length === 0) return [];

    const idsActivos = new Set(productos.map(p => p.id));
    const nuevosNoDisponibles = [];
    let huboCambios = false;

    carrito.items.forEach(item => {
        const disponibleAhora = idsActivos.has(item.productoId);
        if (!disponibleAhora && !item.noDisponible) {
            item.noDisponible = true;
            nuevosNoDisponibles.push(item);
            huboCambios = true;
        } else if (disponibleAhora && item.noDisponible) {
            // El emprendedor lo reactivó: se puede volver a comprar.
            item.noDisponible = false;
            huboCambios = true;
        }
    });

    if (huboCambios) {
        guardarCarritoEnStorage();
        actualizarBadgeCarrito();
        renderCarrito();
    }

    return nuevosNoDisponibles;
}

function hayProductosNoDisponiblesEnCarrito() {
    return carrito.items.some(i => i.noDisponible);
}

function modificarCantidadModal(delta) {
    cantidadModalActual = Math.max(1, cantidadModalActual + delta);
    document.getElementById('modal-cantidad').innerText = cantidadModalActual;
}

// Intenta agregar el producto del modal al carrito. Si el carrito ya tiene
// productos de OTRO emprendedor, dispara el modal de conflicto en vez de agregar.
function agregarAlCarrito() {
    const p = productoModalActual;
    if (!p || !p.emprendedores) return;

    const extra = Object.values(seleccionVariantes).reduce((sum, v) => sum + (Number(v.precio_adicional) || 0), 0);
    const precioUnitario = Number(p.precio) + extra;
    const variantesTexto = Object.entries(seleccionVariantes).map(([grupo, v]) => `${grupo}: ${v.valor}`).join(', ');
    const itemKey = `${p.id}__${variantesTexto}`;

    const nuevoItem = {
        key: itemKey,
        productoId: p.id,
        nombre: p.nombre,
        imagen: p.imagen_url || '',
        precioUnitario,
        cantidad: cantidadModalActual,
        variantesTexto,
        noDisponible: false
    };

    if (carrito.items.length === 0 || carrito.emprendedorId === p.emprendedores.id) {
        _insertarItemEnCarrito(p.emprendedores, nuevoItem);
        cerrarModal();
        mostrarToastCarrito(`Agregado al carrito · ${p.emprendedores.nombre_tienda}`);
        return;
    }

    itemPendienteConflicto = { emprendedor: p.emprendedores, item: nuevoItem };
    document.getElementById('conflicto-tienda-actual').innerText = carrito.emprendedorNombre;
    document.getElementById('modal-conflicto-carrito').classList.remove('hidden');
}

function _insertarItemEnCarrito(emprendedor, nuevoItem) {
    carrito.emprendedorId = emprendedor.id;
    carrito.emprendedorNombre = emprendedor.nombre_tienda;
    carrito.emprendedorWhatsapp = emprendedor.whatsapp || '';

    const existente = carrito.items.find(i => i.key === nuevoItem.key);
    if (existente) {
        existente.cantidad += nuevoItem.cantidad;
    } else {
        carrito.items.push(nuevoItem);
    }
    guardarCarritoEnStorage();
    actualizarBadgeCarrito();
    renderCarrito();
}

function confirmarReemplazoCarrito() {
    if (!itemPendienteConflicto) return;
    carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', items: [] };
    _insertarItemEnCarrito(itemPendienteConflicto.emprendedor, itemPendienteConflicto.item);
    const nombreTienda = itemPendienteConflicto.emprendedor.nombre_tienda;
    itemPendienteConflicto = null;
    document.getElementById('modal-conflicto-carrito').classList.add('hidden');
    cerrarModal();
    mostrarToastCarrito(`Agregado al carrito · ${nombreTienda}`);
}

function cerrarConflictoCarrito() {
    itemPendienteConflicto = null;
    document.getElementById('modal-conflicto-carrito').classList.add('hidden');
}

function modificarCantidadCarrito(key, delta) {
    const item = carrito.items.find(i => i.key === key);
    if (!item || item.noDisponible) return;
    item.cantidad += delta;
    if (item.cantidad <= 0) {
        carrito.items = carrito.items.filter(i => i.key !== key);
    }
    if (carrito.items.length === 0) {
        carrito.emprendedorId = null;
        carrito.emprendedorNombre = '';
        carrito.emprendedorWhatsapp = '';
    }
    guardarCarritoEnStorage();
    actualizarBadgeCarrito();
    renderCarrito();
}

function eliminarDelCarrito(key) {
    carrito.items = carrito.items.filter(i => i.key !== key);
    if (carrito.items.length === 0) {
        carrito.emprendedorId = null;
        carrito.emprendedorNombre = '';
        carrito.emprendedorWhatsapp = '';
    }
    guardarCarritoEnStorage();
    actualizarBadgeCarrito();
    renderCarrito();
}

function vaciarCarrito() {
    carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', items: [] };
    guardarCarritoEnStorage();
    actualizarBadgeCarrito();
    renderCarrito();
}

function actualizarBadgeCarrito() {
    const total = carrito.items.reduce((sum, i) => sum + i.cantidad, 0);
    const badge = document.getElementById('badge-carrito');
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function calcularTotalCarrito() {
    // Los productos no disponibles no cuentan en el total: no se pueden
    // comprar hasta que el usuario los saque del carrito.
    return carrito.items
        .filter(i => !i.noDisponible)
        .reduce((sum, i) => sum + i.precioUnitario * i.cantidad, 0);
}

function renderCarrito() {
    const cont = document.getElementById('carrito-items');
    const subtitulo = document.getElementById('carrito-subtitulo');
    const btnWsp = document.getElementById('carrito-whatsapp-btn');

    if (carrito.items.length === 0) {
        cont.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-center py-16">
                <span class="text-4xl mb-3">🛒</span>
                <p class="text-gray-400 text-sm italic">Todavía no agregaste nada.</p>
            </div>`;
        subtitulo.innerText = 'Vacío';
        btnWsp.classList.add('opacity-40', 'pointer-events-none');
    } else {
        const hayNoDisponibles = hayProductosNoDisponiblesEnCarrito();
        subtitulo.innerText = `De ${carrito.emprendedorNombre}`;

        if (hayNoDisponibles) {
            btnWsp.classList.add('opacity-40', 'pointer-events-none');
        } else {
            btnWsp.classList.remove('opacity-40', 'pointer-events-none');
        }

        const bannerNoDisponible = hayNoDisponibles ? `
            <div class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-center">
                <p class="text-[11px] font-bold text-red-500">⚠ Tenés productos que ya no están disponibles. Eliminalos del carrito para poder enviar tu pedido.</p>
            </div>` : '';

        cont.innerHTML = bannerNoDisponible + carrito.items.map(i => {
            if (i.noDisponible) {
                return `
            <div class="flex gap-3 items-start border-b border-gray-100 pb-4 opacity-60">
                <div class="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 grayscale">
                    <img src="${i.imagen}" alt="${escapeHtml(i.nombre)}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm leading-tight truncate line-through">${escapeHtml(i.nombre)}</p>
                    ${i.variantesTexto ? `<p class="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">${escapeHtml(i.variantesTexto)}</p>` : ''}
                    <p class="text-[10px] font-black uppercase tracking-widest text-red-500 mt-1.5">No disponible</p>
                    <button onclick="eliminarDelCarrito('${i.key}')" class="mt-2 text-[10px] font-black uppercase tracking-widest text-white bg-red-500 hover:bg-red-600 transition-colors rounded-full px-3 py-1.5">
                        Eliminar del carrito
                    </button>
                </div>
            </div>`;
            }
            return `
            <div class="flex gap-3 items-start border-b border-gray-100 pb-4">
                <div class="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0">
                    <img src="${i.imagen}" alt="${escapeHtml(i.nombre)}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm leading-tight truncate">${escapeHtml(i.nombre)}</p>
                    ${i.variantesTexto ? `<p class="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">${escapeHtml(i.variantesTexto)}</p>` : ''}
                    <div class="flex items-center justify-between mt-2">
                        <div class="flex items-center gap-2 bg-gray-100 rounded-full px-1.5 py-0.5">
                            <button onclick="modificarCantidadCarrito('${i.key}', -1)" class="w-6 h-6 rounded-full bg-white shadow font-black text-sm leading-none hover:bg-yellow-400 transition-all active:scale-90">−</button>
                            <span class="font-black text-xs w-4 text-center">${i.cantidad}</span>
                            <button onclick="modificarCantidadCarrito('${i.key}', 1)" class="w-6 h-6 rounded-full bg-white shadow font-black text-sm leading-none hover:bg-yellow-400 transition-all active:scale-90">+</button>
                        </div>
                        <span class="font-black text-sm">${formatoPrecio(i.precioUnitario * i.cantidad)}</span>
                    </div>
                </div>
                <button onclick="eliminarDelCarrito('${i.key}')" class="text-gray-300 hover:text-red-500 transition-colors text-lg leading-none flex-shrink-0">✕</button>
            </div>`;
        }).join('');
    }

    document.getElementById('carrito-total').innerText = formatoPrecio(calcularTotalCarrito());
}

function abrirCarrito() {
    // Red de seguridad extra: si por lo que sea el realtime no llegó a
    // tiempo, al menos acá, justo antes de mostrar el carrito, lo
    // volvemos a validar contra el catálogo activo.
    sincronizarDisponibilidadCarrito();
    renderCarrito();
    document.getElementById('carrito-overlay').classList.remove('hidden');
    document.getElementById('carrito-drawer').classList.remove('translate-x-full');
    bloquearScrollBody();
}

function cerrarCarrito() {
    document.getElementById('carrito-overlay').classList.add('hidden');
    document.getElementById('carrito-drawer').classList.add('translate-x-full');
    desbloquearScrollBody();
}

function mostrarToastCarrito(texto) {
    const toast = document.getElementById('toast-carrito');
    document.getElementById('toast-carrito-texto').innerText = texto;
    toast.classList.remove('hidden');
    toast.classList.add('flex');
    clearTimeout(mostrarToastCarrito._timer);
    mostrarToastCarrito._timer = setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('flex');
    }, 2600);
}

// Arma el mensaje con el detalle del pedido y abre WhatsApp directo al
// número del emprendedor dueño del carrito (emprendedores.whatsapp en Supabase).
async function enviarPedidoWhatsapp() {
    if (carrito.items.length === 0) return;
    if (!carrito.emprendedorWhatsapp) {
        alert('Este emprendedor todavía no cargó un número de WhatsApp para recibir pedidos.');
        return;
    }

    // 1) Chequeo rápido contra la caché local `productos` (lo que sabemos
    // que está activo ahora mismo en este navegador). Si algo se desactivó
    // recién, se marca como no disponible (no se saca solo) y se frena el
    // envío hasta que el usuario lo elimine a mano.
    sincronizarDisponibilidadCarrito();
    if (hayProductosNoDisponiblesEnCarrito()) {
        return;
    }

    // 2) Chequeo final directo contra Supabase: por si el emprendedor
    // desactivó algo en este mismo instante y el realtime todavía no
    // llegó a actualizar la caché local. Si encontramos algo desactivado,
    // lo marcamos como no disponible (queda en el carrito) y frenamos el
    // envío para que el usuario lo elimine antes de mandar el pedido.
    const idsCarrito = carrito.items.map(i => i.productoId);
    const { data: vigentes, error: errorVigencia } = await supabase
        .from('productos')
        .select('id, activo, emprendedores!inner(activo)')
        .in('id', idsCarrito);

    if (!errorVigencia && vigentes) {
        const idsVigentes = new Set(
            vigentes.filter(p => p.activo && p.emprendedores && p.emprendedores.activo).map(p => p.id)
        );
        const desactivadosAhora = carrito.items.filter(i => !idsVigentes.has(i.productoId));
        if (desactivadosAhora.length > 0) {
            desactivadosAhora.forEach(i => { i.noDisponible = true; });
            guardarCarritoEnStorage();
            actualizarBadgeCarrito();
            renderCarrito();
            return;
        }
    }
    // Si hubo un error de red al validar, seguimos igual: no queremos
    // bloquear el pedido por un problema de conexión momentáneo.

    const baseUrl = `${window.location.origin}${window.location.pathname}`;

    let msg = `Hola ${carrito.emprendedorNombre}! Quiero hacer este pedido desde ComunidadPlace:\n\n`;
    carrito.items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.nombre}`;
        if (i.variantesTexto) msg += ` (${i.variantesTexto})`;
        msg += ` x${i.cantidad} - ${formatoPrecio(i.precioUnitario * i.cantidad)}\n`;
        if (i.productoId) msg += `   ${baseUrl}?producto=${i.productoId}\n`;
    });
    msg += `\nTotal: ${formatoPrecio(calcularTotalCarrito())}`;

    window.open(`https://wa.me/${carrito.emprendedorWhatsapp}?text=${encodeURIComponent(msg)}`, '_blank');
}
