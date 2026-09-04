let productos = [];        // productos ya traídos de Supabase (con joins)
let categoriasDB = [];
let emprendedoresCache = {}; // id -> datos del emprendedor, se llena en cargarEmprendedoresFila()
let emprendedoresLista = []; // lista activa para el directorio "Ver todos"
let productosNuevosPendientes = []; // productos que llegaron por INSERT y todavía no se incorporaron a la grilla: [{id, emprendedor_nombre}]

// Paginación incremental ("Ver más") del catálogo público: en vez de
// renderizar TODOS los productos filtrados de una, se muestra un lote
// inicial y se va agrandando a medida que el usuario pide más. Evita una
// página larguísima con cientos de cards cargadas (e imágenes) de entrada.
const CP_LOTE_PRODUCTOS = 24;
let cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
let carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', costoEnvio: 0, envioSeleccionado: true, items: [] };
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
            cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
    const lista = document.getElementById('lista-opciones-categoria') || panel;
    // Sacamos las opciones cargadas dinámicamente antes de reconstruir
    // (dejamos el botón fijo "Todos" que ya está en el HTML).
    lista.querySelectorAll('.opcion-categoria:not([data-categoria="Todos"])').forEach(b => b.remove());
    data.forEach(c => {
        const btn = document.createElement('button');
        btn.className = "opcion-categoria w-full flex items-center justify-between text-left px-4 py-2.5 rounded-xl font-bold text-sm uppercase hover:bg-yellow-50 transition-colors";
        btn.dataset.categoria = c.id;
        btn.innerHTML = `<span class="truncate">${escapeHtml(c.nombre)}</span><span class="check text-yellow-500 font-black hidden">✓</span>`;
        btn.addEventListener('click', () => seleccionarCategoriaFiltro(btn, c.id, c.nombre));
        lista.appendChild(btn);
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
    aplicarFiltros();
}

function actualizarBotonLimpiarFiltros() {
    const btn = document.getElementById('btn-limpiar-filtros');
    const hayFiltros = categoriaActivaId !== 'Todos' || tiendaActivaId !== 'Todos';
    btn.classList.toggle('hidden', !hayFiltros);
    btn.classList.toggle('flex', hayFiltros);
}

async function cargarEmprendedoresFila() {
    let { data, error } = await supabase
        .from('emprendedores')
        .select('id, nombre_tienda, logo_url, banner_url, bio, medios_pago, created_at, suscripcion_estado, fecha_vencimiento_suscripcion, usuarios(usuario)')
        .eq('activo', true)
        .order('nombre_tienda');
    if (error) { console.error(error); return; }

    // El filtro de arriba (activo=true) sólo saca los bloqueos manuales
    // del admin. Acá completamos el chequeo: si a una tienda se le venció
    // el mes gratis o la suscripción sin pagar, tampoco se muestra en la
    // vitrina pública (ver calcularEstadoAcceso en supabase-client.js).
    data = (data || []).filter(e => !calcularEstadoAcceso(e).bloqueado);

    // Caché id -> datos del emprendedor, usada por el manejo de
    // Realtime de productos (armar el aviso de "producto nuevo de X" sin
    // tener que ir a buscar el nombre de la tienda a Supabase cada vez)
    // y por el directorio "Ver todos".
    emprendedoresLista = data || [];
    emprendedoresCache = {};
    emprendedoresLista.forEach(e => { emprendedoresCache[e.id] = e; });

    const sinEmprendedores = emprendedoresLista.length === 0;
    const btnVerTodosDesktop = document.getElementById('btn-ver-todos-emprendedores-desktop');
    const btnVerTodosMobile = document.getElementById('btn-ver-todos-emprendedores-mobile');
    if (btnVerTodosDesktop) btnVerTodosDesktop.classList.toggle('cp-emp-oculto', sinEmprendedores);
    if (btnVerTodosMobile) btnVerTodosMobile.classList.toggle('cp-emp-oculto', sinEmprendedores);

    const directorioAbierto = document.getElementById('modal-directorio-emprendedores');
    if (directorioAbierto && !directorioAbierto.classList.contains('hidden')) {
        renderDirectorioEmprendedores();
    }

    // --- Fila de logos debajo del banner (abre el perfil del emprendedor) ---
    const cont = document.getElementById('emprendedores-fila');
    if (cont) {
        cont.innerHTML = data.length === 0 ? `
            <div class="w-full flex items-center gap-3 py-2 px-1">
                <span class="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-yellow-50 flex items-center justify-center flex-shrink-0">
                    <svg class="w-5 h-5 sm:w-6 sm:h-6 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                </span>
                <div class="min-w-0">
                    <p class="font-black text-xs sm:text-sm uppercase tracking-widest">Todavía no hay emprendedores</p>
                    <p class="text-gray-400 text-[11px] sm:text-xs mt-0.5">¡Sé el primero en sumar tu emprendimiento a la comunidad!</p>
                </div>
                <button type="button" onclick="abrirModalPostulacion()" class="ml-auto flex-shrink-0 hidden sm:inline-flex items-center gap-1.5 bg-black text-white px-3.5 py-2 rounded-full text-[10px] font-black uppercase tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95">
                    Quiero vender
                </button>
            </div>
        ` : data.map(e => {
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
        const lista = document.getElementById('lista-opciones-emprendedor') || panel;
        lista.querySelectorAll('.opcion-emprendedor:not([data-emprendedor="Todos"])').forEach(b => b.remove());
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
            lista.appendChild(btn);
        });
        marcarOpcionActivaEnPanel(panel, '.opcion-emprendedor', 'emprendedor', tiendaActivaId);
    }
}

// ============================================================
// TIEMPO REAL: escucha cambios en Supabase y refresca la vitrina sola
// ============================================================
function iniciarRealtime() {
    // Antes: CUALQUIER cambio de CUALQUIER emprendedor (bio, whatsapp,
    // banner, horario, redes, medios de pago... todo lo que NO se muestra
    // en la card) hacía un refetch + re-render de TODO el catálogo para
    // TODOS los visitantes de la home. Con varios emprendedores editando su
    // perfil seguido, esto se disparaba todo el tiempo y era la causa real
    // del parpadeo en la grilla (no el diffing en sí, que ya andaba bien).
    // Ahora: solo tocamos lo que hace falta según qué cambió puntualmente.
    //   - UPDATE con nombre_tienda/logo_url distintos -> merge local +
    //     redibuja SOLO las cards de esa tienda (como ya hace productos).
    //   - UPDATE de "activo" (bloqueo/reactivación) -> ahí sí hace falta
    //     resync completo, porque cambia qué productos son visibles.
    //   - Resto de campos (bio, whatsapp, banner, etc.) -> solo actualiza
    //     la fila de logos / panel de filtro, sin tocar la grilla.
    //   - Sin payload (resync pasivo por reconexión), o DELETE -> resync
    //     completo, como red de seguridad.
    const refrescarEmprendedores = debounce(async (payload) => {
        if (!payload || !payload.eventType || payload.eventType === 'DELETE') {
            await cargarEmprendedoresFila();
            await cargarProductos();
            aplicarFiltros();
            sincronizarDisponibilidadCarrito();
            return;
        }

        const nuevo = payload.new;
        const anterior = emprendedoresCache[nuevo.id];
        // OJO: emprendedoresCache ahora sólo contiene tiendas visibles
        // públicamente (cargarEmprendedoresFila ya descarta las bloqueadas
        // por el admin Y las que vencieron su mes gratis/suscripción sin
        // pagar). Por eso comparamos "visibilidad" en vez de solo
        // "activo": una tienda puede pasar de invisible a visible (o al
        // revés) sin que cambie el campo activo, por ejemplo si venció el
        // plazo de la prueba gratis.
        const estabaVisible = !!anterior;
        const ahoraVisible = !calcularEstadoAcceso(nuevo).bloqueado;
        const cambioVisibilidad = estabaVisible !== ahoraVisible;
        const cambioNombreOLogo = anterior && (anterior.nombre_tienda !== nuevo.nombre_tienda || anterior.logo_url !== nuevo.logo_url);

        // Liviano: refrescar la fila de logos y el panel de filtro no cuesta nada.
        await cargarEmprendedoresFila();

        if (cambioVisibilidad) {
            // Se bloqueó/reactivó la tienda o venció/se renovó su
            // suscripción: cambia qué productos entran en el catálogo.
            await cargarProductos();
            aplicarFiltros();
            sincronizarDisponibilidadCarrito();
            return;
        }

        if (cambioNombreOLogo) {
            // Solo repintamos las cards de ESTA tienda puntual, sin tocar
            // el resto de la grilla ni volver a pedirle nada a Supabase.
            productos.forEach((p, idx) => {
                if (p.emprendedores && String(p.emprendedores.id) === String(nuevo.id)) {
                    productos[idx] = {
                        ...p,
                        emprendedores: { ...p.emprendedores, nombre_tienda: nuevo.nombre_tienda, logo_url: nuevo.logo_url }
                    };
                    actualizarTarjetaProducto(productos[idx]);
                }
            });
        }
        // Si no cambió nombre/logo/activo (ej: editó el whatsapp o la bio),
        // no hay nada más que hacer: la grilla ni se entera.
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

    suscribirTabla('productos', manejarCambioProducto);
    suscribirTabla('emprendedores', refrescarEmprendedores);
    suscribirTabla('categorias', refrescarCategorias);
    suscribirTabla('variantes', refrescarVariantesModal);
}

// ------------------------------------------------------------
// TIEMPO REAL DE "productos": actualización granular
// ------------------------------------------------------------
// En vez de recargar todo el catálogo ante cualquier cambio (lo que hacía
// parpadear/recomponer toda la grilla y podía sacar al usuario de donde
// estaba leyendo), reaccionamos distinto según el tipo de evento:
//
//   UPDATE  -> se pisan los datos locales de ESE producto (precio, precio
//              anterior/oferta, disponibilidad -campo "activo"-, etc.) y se
//              vuelve a pintar SOLO esa tarjeta. No se toca el resto de la
//              grilla ni se llama a Supabase de nuevo.
//   INSERT  -> el producto NO se agrega solo a la grilla: queda en espera
//              y se muestra un aviso ("Hay 1 producto nuevo de X"). El
//              usuario decide si lo quiere ver ahora o lo ignora.
//   DELETE  -> se saca únicamente esa tarjeta del DOM.
//
// `payload.new` que manda Supabase Realtime siempre trae la fila completa
// actualizada, así que no hace falta volver a pedirle nada al servidor
// para aplicar el cambio (ver fusionarProductoLocal). Si en algún momento
// agregás más campos "críticos" del estilo precio/disponibilidad (por
// ejemplo un stock numérico), no hace falta tocar nada de esto: como se
// mergean TODOS los campos de la fila, ya quedan contemplados solos.
function manejarCambioProducto(payload) {
    if (!payload || !payload.eventType) {
        // Esto pasa cuando suscribirTabla nos llama sin evento real: el
        // canal se cayó y se reconectó, o el usuario volvió a la pestaña /
        // recuperó conexión (ya viene throttleado desde supabase-client.js,
        // no se dispara más de 1 vez cada 20s). No sabemos qué cambió
        // puntualmente, así que resincronizamos el catálogo completo.
        console.debug('[Realtime productos] resync pasivo (sin payload)');
        resincronizarProductosDebounced();
        return;
    }

    console.debug('[Realtime productos]', payload.eventType, payload.new || payload.old);

    if (payload.eventType === 'INSERT') {
        manejarProductoInsertado(payload.new);
    } else if (payload.eventType === 'UPDATE') {
        manejarProductoActualizado(payload.new);
    } else if (payload.eventType === 'DELETE') {
        manejarProductoEliminado(payload.old);
    }
}

// Red de seguridad: recarga el catálogo entero. Se usa solo cuando no
// tenemos el detalle del cambio (ver manejarCambioProducto de arriba).
// OJO: esto NO toca `productosNuevosPendientes`. cargarProductos() trae
// todos los productos activos (los pendientes incluidos, porque están
// activos en la base, solo que el usuario todavía no aceptó verlos), y
// aplicarFiltros() ya se encarga de excluir de la grilla lo que siga
// pendiente. Si acá se vaciara la lista de pendientes, un resync de fondo
// (por ej. al volver de otra pestaña) haría desaparecer el aviso sin que
// el usuario lo haya visto ni decidido nada.
async function resincronizarProductosCompleto() {
    await cargarProductos();
    aplicarFiltros();
    sincronizarDisponibilidadCarrito();
}
const resincronizarProductosDebounced = debounce(resincronizarProductosCompleto, 350);

// Pisa en `productos[idx]` los campos de la fila nueva que llegó por
// Realtime, conservando los datos "de join" (nombre de categoría, datos del
// emprendedor) que esa fila no trae. Si cambió el id de categoría o de
// emprendedor (rarísimo, pero por las dudas), busca el nombre actualizado
// en lo que ya tenemos cargado en memoria (categoriasDB / emprendedoresCache)
// en vez de ir a pedirlo a Supabase.
function fusionarProductoLocal(idx, nuevo) {
    normalizarProducto(nuevo);
    const actual = productos[idx];

    let categorias = actual.categorias;
    if (String(nuevo.categoria_id) !== String(actual.categoria_id)) {
        const cat = categoriasDB.find(c => String(c.id) === String(nuevo.categoria_id));
        categorias = cat ? { id: cat.id, nombre: cat.nombre } : null;
    }

    let emprendedores = actual.emprendedores;
    if (String(nuevo.emprendedor_id) !== String(actual.emprendedor_id)) {
        const emp = emprendedoresCache[nuevo.emprendedor_id];
        if (emp) emprendedores = { ...actual.emprendedores, id: emp.id, nombre_tienda: emp.nombre_tienda, logo_url: emp.logo_url };
    }

    productos[idx] = { ...actual, ...nuevo, categorias, emprendedores };
}

// Vuelve a pintar SOLO la tarjeta de este producto (si está visible con los
// filtros actuales), sin tocar ninguna otra card ni la posición de scroll.
// OJO: acá se reemplaza SIEMPRE que la card exista en pantalla, sin
// comparar hash. La comparación de hash es útil en mostrarProductos()
// (donde hay que decidir, para TODA la grilla, qué cards tocar y cuáles
// dejar intactas), pero acá ya sabemos con certeza que este producto
// puntual cambió (nos llamaron desde manejarProductoActualizado con el
// payload real de Supabase) — comparar hash de nuevo sólo puede hacer que
// una actualización legítima se pierda en silencio si, por lo que sea
// (ej: Supabase devuelve "precio" como string por REST y como number por
// Realtime), el hash no varía aunque el dato sí.
function actualizarTarjetaProducto(p) {
    const card = document.querySelector(`[data-producto-id="${p.id}"]`);
    if (!card) return; // no está en pantalla ahora mismo (no pasa el filtro/búsqueda activos): no hay nada que redibujar

    const wrapper = document.createElement('div');
    wrapper.innerHTML = crearCardHtmlProducto(p);
    const nuevoEl = wrapper.firstElementChild;
    card.replaceWith(nuevoEl);
}

async function manejarProductoActualizado(nuevo) {
    // Comparación por String(): si el id de producto fuera numérico
    // (bigint) en vez de uuid, un "===" estricto entre number y string
    // podía fallar y hacer que una simple actualización de precio se
    // tratara como si el producto no existiera localmente.
    const idx = productos.findIndex(p => String(p.id) === String(nuevo.id));

    // OJO: acá NO tratamos `activo === false` como si el producto se
    // hubiera borrado. `activo` es el campo que el emprendedor usa para
    // marcar "sin stock" (lo pausa) y también "disponible de nuevo" (lo
    // reactiva); en ambos casos la card tiene que PERMANECER en la
    // grilla, solo cambia su estado visual (ver crearCardHtmlProducto,
    // que ya pinta el badge "Sin stock" según p.activo). Sacar la card
    // del todo queda reservado únicamente para el evento DELETE real
    // (ver manejarProductoEliminado), que es cuando el producto se borró
    // en serio de la base.
    if (idx === -1) {
        // No lo teníamos localmente (por ej: estaba pausado y se reactivó,
        // o pertenece a una tienda que recién se activó): se comporta igual
        // que si fuera un producto nuevo -> aviso, no se inserta solo.
        await manejarProductoInsertado(nuevo);
        return;
    }

    fusionarProductoLocal(idx, nuevo);
    actualizarTarjetaProducto(productos[idx]);
    // No se recarga la grilla ni se mueve al usuario: sincronizamos el
    // carrito en silencio por si esto afecta algún ítem que tenga cargado
    // (ver nota sobre precios en sincronizarDisponibilidadCarrito).
    sincronizarDisponibilidadCarrito(false);
    // Si el visitante tiene abierto el modal de ESTE producto justo cuando
    // el emprendedor lo edita (precio, sin stock, etc.), lo reflejamos ahí
    // también, en vez de que quede desactualizado hasta que lo vuelva a abrir.
    actualizarModalSiCorresponde(productos[idx]);
}

// Refresca el modal de detalle (imagen grayscale, badges, precio, botón de
// agregar) cuando el producto que se está viendo cambió por Realtime.
// `productoModalActual` seguía apuntando al objeto VIEJO (fusionarProductoLocal
// crea un objeto nuevo en `productos[idx]`), así que hay que reasignarlo antes
// de repintar, o el modal seguiría mostrando datos desactualizados.
function actualizarModalSiCorresponde(p) {
    if (!productoModalActual || String(productoModalActual.id) !== String(p.id)) return;
    const modal = document.getElementById('modal-producto');
    if (!modal || !modal.classList.contains('abierto')) return;

    productoModalActual = p;

    const modalImg = document.getElementById('modal-img');
    const sinStock = p.activo === false;
    if (modalImg) {
        modalImg.classList.toggle('grayscale', sinStock);
        modalImg.classList.toggle('opacity-50', sinStock);
    }
    const modalBadgeNuevo = document.getElementById('modal-badge-nuevo');
    if (modalBadgeNuevo) modalBadgeNuevo.classList.toggle('hidden', sinStock || !esProductoNuevoVigente(p));
    const modalBadgeSinStock = document.getElementById('modal-badge-sin-stock');
    if (modalBadgeSinStock) modalBadgeSinStock.classList.toggle('hidden', !sinStock);
    const modalBtnAgregar = document.getElementById('modal-btn-agregar');
    const modalBtnAgregarTexto = document.getElementById('modal-btn-agregar-texto');
    if (modalBtnAgregar) {
        modalBtnAgregar.disabled = sinStock;
        if (modalBtnAgregarTexto) modalBtnAgregarTexto.textContent = sinStock ? 'Sin stock' : 'Agregar al carrito';
    }

    actualizarPrecioYWhatsapp();
}

function manejarProductoEliminado(viejo) {
    const id = viejo && viejo.id;
    if (!id) return;

    const habiaEnLocal = productos.some(p => String(p.id) === String(id));
    productos = productos.filter(p => String(p.id) !== String(id));

    const estabaPendiente = productosNuevosPendientes.some(p => String(p.id) === String(id));
    if (estabaPendiente) {
        productosNuevosPendientes = productosNuevosPendientes.filter(p => String(p.id) !== String(id));
        mostrarAvisoProductosNuevos();
    }

    if (!habiaEnLocal) return;

    const card = document.querySelector(`[data-producto-id="${id}"]`);
    if (card) card.remove();

    // Si esa era la última card visible, mostramos el estado "sin resultados".
    const contenedor = document.getElementById('contenedor-productos');
    if (contenedor && contenedor.children.length === 0) aplicarFiltros();

    sincronizarDisponibilidadCarrito(false);

    if (productoModalActual && String(productoModalActual.id) === String(id)) {
        cerrarModal();
        mostrarToast('Este producto ya no está disponible.', 'error');
    }
}

// Producto nuevo: NO se agrega a la grilla. Se guarda en la lista de
// pendientes y se arma/actualiza el aviso para que el usuario decida.
async function manejarProductoInsertado(nuevo) {
    if (nuevo.activo === false) return; // cargado pero todavía no publicado
    if (productos.some(p => String(p.id) === String(nuevo.id))) return; // ya lo tenemos (evento duplicado)
    if (productosNuevosPendientes.some(p => String(p.id) === String(nuevo.id))) return;

    const emprendedor = emprendedoresCache[nuevo.emprendedor_id];
    // Tienda inactiva, o todavía no la cargamos en caché (recién creada):
    // no molestamos con el aviso. Si en verdad corresponde mostrarlo,
    // la próxima resincronización completa (reconexión / volver a la
    // pestaña) lo va a traer igual.
    if (!emprendedor) {
        console.debug('[Realtime productos] INSERT ignorado: no hay caché para emprendedor_id', nuevo.emprendedor_id);
        return;
    }

    productosNuevosPendientes.push({ id: nuevo.id, emprendedor_nombre: emprendedor.nombre_tienda });
    mostrarAvisoProductosNuevos();
}

// ------------------------------------------------------------
// AVISO "PRODUCTOS NUEVOS" (agrupa varios inserts mientras el usuario navega)
// ------------------------------------------------------------
// Timer del autoocultado (20s). Se reinicia cada vez que el aviso se
// actualiza (por ej. llega otro producto nuevo mientras ya estaba visible).
let avisoProductosNuevosTimer = null;

// El aviso queda fijo justo debajo del header (que tiene su propia altura
// variable: cambia con el wrap de la barra de búsqueda en pantallas chicas).
// Se recalcula cada vez que se muestra y también al redimensionar/rotar.
function posicionarAvisoProductosNuevos() {
    const el = document.getElementById('aviso-productos-nuevos');
    const header = document.getElementById('site-header');
    if (!el || !header) return;
    el.style.top = (header.offsetHeight + 12) + 'px';
}
window.addEventListener('resize', posicionarAvisoProductosNuevos);

// Oculta el aviso deslizándolo de nuevo hacia arriba (reversa de la entrada)
// y recién después de que termina la transición le agrega `hidden`, para no
// cortar la animación.
function ocultarAvisoProductosNuevos() {
    const el = document.getElementById('aviso-productos-nuevos');
    if (!el) return;
    el.classList.remove('aviso-visible');
    setTimeout(() => el.classList.add('hidden'), 500);
}

function mostrarAvisoProductosNuevos() {
    const el = document.getElementById('aviso-productos-nuevos');
    if (!el) return;

    clearTimeout(avisoProductosNuevosTimer);

    if (productosNuevosPendientes.length === 0) {
        ocultarAvisoProductosNuevos();
        return;
    }

    posicionarAvisoProductosNuevos();

    const cantidad = productosNuevosPendientes.length;
    const porEmprendedor = new Map();
    productosNuevosPendientes.forEach(p => {
        porEmprendedor.set(p.emprendedor_nombre, (porEmprendedor.get(p.emprendedor_nombre) || 0) + 1);
    });

    let textoTitulo, extra = '';
    if (cantidad === 1) {
        textoTitulo = `Hay 1 producto nuevo de <span class="text-yellow-700">${escapeHtml(productosNuevosPendientes[0].emprendedor_nombre)}</span>`;
    } else if (porEmprendedor.size === 1) {
        // Varios productos, pero todos de la misma tienda: no hace falta desglosar.
        const [nombre] = porEmprendedor.keys();
        textoTitulo = `Hay ${cantidad} productos nuevos de <span class="text-yellow-700">${escapeHtml(nombre)}</span>`;
    } else {
        textoTitulo = `Hay ${cantidad} productos nuevos`;
        extra = `<ul class="text-xs text-gray-500 font-semibold mt-1 space-y-0.5">` +
            Array.from(porEmprendedor.entries()).map(([nombre, n]) =>
                `<li>• ${n} de ${escapeHtml(nombre)}</li>`).join('') +
            `</ul>`;
    }

    // Si solo hay UN producto nuevo, la acción principal lleva directo a
    // ese producto ("Ver producto"); si hay varios, incorpora todos los
    // pendientes a la grilla de una ("Ver novedades") sin forzar un
    // refresh completo de la página.
    const accionPrincipal = cantidad === 1
        ? `<button onclick="verProductoNuevoDesdeAviso('${productosNuevosPendientes[0].id}')" class="w-full sm:w-auto text-center bg-black text-white px-4 py-2 rounded-full font-black uppercase text-[11px] tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95 whitespace-nowrap">Ver producto</button>`
        : `<button onclick="verNovedadesProductos()" class="w-full sm:w-auto text-center bg-black text-white px-4 py-2 rounded-full font-black uppercase text-[11px] tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95 whitespace-nowrap">Ver novedades</button>`;

    el.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-4 pr-10 sm:pr-12">
            <div class="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                <span class="flex-shrink-0 w-10 h-10 rounded-full bg-yellow-400 flex items-center justify-center">
                    <svg class="w-5 h-5 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6.2 2 3 6.2V20a2 2 0 002 2h14a2 2 0 002-2V6.2L17.8 2z"/>
                        <path d="M3 6.2h18"/>
                        <path d="M16 10.2a4 4 0 01-8 0"/>
                    </svg>
                </span>
                <div class="min-w-0">
                    <p class="text-sm font-bold leading-snug">${textoTitulo}</p>
                    ${extra}
                </div>
            </div>
            <div class="sm:flex-shrink-0">
                ${accionPrincipal}
            </div>
        </div>
        <button onclick="cerrarAvisoProductosNuevos()" aria-label="Cerrar aviso" class="absolute top-3 right-3 sm:top-1/2 sm:-translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-black hover:bg-gray-100 transition-colors">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>
        </button>`;

    // Entra deslizándose desde arriba. Se saca `hidden` primero y recién en
    // el siguiente frame se agrega `aviso-visible`, para que la transición
    // CSS se dispare siempre (incluso si el aviso ya estaba abierto y solo
    // cambió el texto por otro producto nuevo).
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.add('aviso-visible');

    // Se autooculta a los 20s para no molestar al visitante. Si llega otro
    // producto nuevo mientras está visible, el timer se reinicia arriba.
    avisoProductosNuevosTimer = setTimeout(cerrarAvisoProductosNuevos, 20000);
}

// El usuario cierra el aviso (a mano o por el autoocultado de 20s): se
// descarta la lista de pendientes y sigue navegando normal. Esos productos
// van a aparecer solos la próxima vez que se resincronice el catálogo
// completo (recarga de página, reconexión, etc.), no hace falta
// "recordarlos" acá.
function cerrarAvisoProductosNuevos() {
    clearTimeout(avisoProductosNuevosTimer);
    productosNuevosPendientes = [];
    ocultarAvisoProductosNuevos();
}

// Trae de Supabase (con sus joins) los productos pendientes que el usuario
// quiere ver, los agrega a `productos` y repinta la grilla con el diff de
// siempre (mostrarProductos ya se encarga de no tocar las cards que no
// cambiaron).
async function incorporarProductosNuevosPendientes(ids) {
    if (!ids || ids.length === 0) return;

    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, banner_url, bio, ubicacion, mapa_url, horario_atencion, instagram, facebook, tiktok, medios_pago, costo_envio, created_at, suscripcion_estado, fecha_vencimiento_suscripcion, usuarios(usuario))')
        .in('id', ids)
        .eq('activo', true)
        .eq('emprendedores.activo', true);

    if (error) {
        console.error('Error incorporando productos nuevos:', error);
        mostrarToast('No se pudieron cargar los productos nuevos.', 'error');
        return;
    }

    // Igual que en cargarProductos(): el filtro de la consulta sólo saca
    // el bloqueo manual del admin, acá sumamos el chequeo de mes
    // gratis/suscripción vencida.
    data
        .filter(p => p.emprendedores && !calcularEstadoAcceso(p.emprendedores).bloqueado)
        .forEach(p => {
            normalizarProducto(p);
            if (!productos.some(existente => String(existente.id) === String(p.id))) productos.push(p);
        });
    precargarImagenesProductos();
    aplicarFiltros();
}

function quitarDePendientesNuevos(ids) {
    const idsASacar = new Set(ids.map(String));
    productosNuevosPendientes = productosNuevosPendientes.filter(p => !idsASacar.has(String(p.id)));
    mostrarAvisoProductosNuevos();
}

// Acción "Ver producto" (un solo producto nuevo): lo incorpora a la grilla
// y abre directo su modal de detalle.
async function verProductoNuevoDesdeAviso(id) {
    await incorporarProductosNuevosPendientes([id]);
    quitarDePendientesNuevos([id]);
    await verDetalles(id);
}

// Acción "Ver novedades" (varios productos nuevos): incorpora todos los
// pendientes a la grilla de una y lleva al usuario arriba de la vitrina,
// sin recargar la página.
async function verNovedadesProductos() {
    const ids = productosNuevosPendientes.map(p => p.id);
    await incorporarProductosNuevosPendientes(ids);
    quitarDePendientesNuevos(ids);
    const destino = document.getElementById('contenedor-productos');
    if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Normaliza los campos numéricos de un producto apenas llega, sea por REST
// (Supabase devuelve las columnas numeric/decimal como STRING, ej "1500.00",
// para no perder precisión) o por Realtime (llega como number nativo). Si no
// se normaliza acá, dos productos con el mismo precio real podían terminar
// con hashes distintos ("pr":"1500.00" vs "pr":1500) sólo por el tipo de
// dato, lo que rompía el diff: cards que en verdad no cambiaron se
// redibujaban igual (parpadeo en resyncs), o el sistema de comparación se
// volvía impredecible.
function normalizarProducto(p) {
    if (!p) return p;
    p.precio = p.precio === null || p.precio === undefined ? p.precio : Number(p.precio);
    p.precio_anterior = p.precio_anterior === null || p.precio_anterior === undefined ? p.precio_anterior : Number(p.precio_anterior);
    return p;
}

// OJO: NO filtramos por productos.activo acá. `activo` es el campo que el
// emprendedor usa tanto para "publicado" como para "sin stock" (lo pausa
// cuando se queda sin stock, lo reactiva cuando repone). Si lo filtráramos
// acá, un producto sin stock desaparecería del todo de la grilla en vez de
// quedar visible marcado "Sin stock" (ver crearCardHtmlProducto). La única
// forma de que una card se saque de verdad es que la fila se BORRE
// (evento DELETE de Realtime, ver manejarProductoEliminado).
// Sí seguimos filtrando por la tienda (emprendedores.activo): si el
// emprendedor está inactivo, sus productos no se muestran.
// GUARD ANTI-RACE: cargarProductos() se dispara desde varios lugares que
// no se coordinan entre sí (carga inicial, resync pasivo del canal
// "productos", resync pasivo del canal "emprendedores", cambio de
// categoría...). Si dos llamadas quedan "al aire" al mismo tiempo (típico
// justo cuando se corta/reconecta la red, ej. al reiniciar Live Server),
// no hay garantía de que la respuesta HTTP más reciente sea la que vuelve
// última: una request vieja puede resolver DESPUÉS de una más nueva y
// pisar `productos` con datos desactualizados (por ejemplo, un producto
// que ya estaba "sin stock" volvía a mostrarse como disponible hasta el
// próximo resync). Por eso cada llamada saca un número de secuencia y solo
// la respuesta de la ÚLTIMA llamada en salir puede escribir en `productos`.
let _cargarProductosSeq = 0;

async function cargarProductos() {
    const miSeq = ++_cargarProductosSeq;

    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, banner_url, bio, ubicacion, mapa_url, horario_atencion, instagram, facebook, tiktok, medios_pago, costo_envio, created_at, suscripcion_estado, fecha_vencimiento_suscripcion, usuarios(usuario))')
        .eq('emprendedores.activo', true)
        .order('created_at', { ascending: false });

    // Mientras esta consulta viajaba, se disparó otra llamada más nueva:
    // esa es la que manda. Descartamos esta respuesta para no pisar datos
    // más frescos con datos viejos.
    if (miSeq !== _cargarProductosSeq) return;

    if (error) {
        console.error(error);
        document.getElementById('contenedor-productos').innerHTML =
            `<p class="col-span-full text-center py-10 text-red-400 italic">No se pudieron cargar los productos. Revisá la conexión con Supabase.</p>`;
        return;
    }
    // El filtro de la consulta (emprendedores.activo) sólo saca las
    // tiendas bloqueadas a mano por el admin. Sumamos acá el chequeo de
    // calcularEstadoAcceso: si el mes gratis o la suscripción vencieron
    // sin pagar, sus productos tampoco entran al catálogo público.
    productos = data
        .filter(p => p.emprendedores && !calcularEstadoAcceso(p.emprendedores).bloqueado)
        .map(normalizarProducto);
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
function crearCardHtmlProducto(p) {
    const tienda = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    const logoTienda = p.emprendedores ? p.emprendedores.logo_url : '';
    const inicialTienda = tienda ? tienda.charAt(0).toUpperCase() : '?';
    const avatarTienda = logoTienda
        ? `<img src="${miniaturaCloudinary(logoTienda, 60)}" alt="${escapeHtml(tienda)}" width="60" height="60" class="w-4 h-4 sm:w-6 sm:h-6 rounded-full object-cover flex-shrink-0 ring-1 ring-black/5" loading="lazy" decoding="async">`
        : `<span class="w-4 h-4 sm:w-6 sm:h-6 rounded-full bg-yellow-400 text-black text-[7px] sm:text-[10px] font-black flex items-center justify-center flex-shrink-0">${escapeHtml(inicialTienda)}</span>`;
    const descuentoPct = calcularDescuentoPorcentaje(p.precio_anterior, p.precio);
    // `activo === false` = el emprendedor lo pausó por falta de stock. La
    // card sigue en la grilla, solo se marca "Sin stock" y no se puede
    // comprar (ver agregarAlCarrito).
    const sinStock = p.activo === false;
    // data-hash guarda una foto de los datos que afectan el render de esta
    // card: sirve para que mostrarProductos() sepa si tiene que redibujarla
    // o puede dejarla tal cual (evita el parpadeo al llegar cambios por
    // tiempo real de OTROS productos/otros emprendedores).
    const hash = escapeHtml(JSON.stringify({
        n: p.nombre, pr: Number(p.precio), pa: p.precio_anterior != null ? Number(p.precio_anterior) : p.precio_anterior, img: p.imagen_url,
        cat: p.categorias ? p.categorias.nombre : null,
        t: tienda, l: logoTienda, nv: esProductoNuevoVigente(p), act: p.activo === false ? false : true
    }));
    return `
        <div class="group cursor-pointer h-full flex flex-col bg-white rounded-md sm:rounded-lg border border-gray-200 hover:shadow-[0_2px_12px_rgba(0,0,0,0.12)] hover:border-gray-300 transition-all duration-200 overflow-hidden animate-fade-in" data-producto-id="${p.id}" data-hash="${hash}" onclick="verDetalles('${p.id}')">
            <div class="relative aspect-square overflow-hidden bg-white flex-shrink-0 flex items-center justify-center">
                <img src="${miniaturaCloudinary(p.imagen_url, 500)}" alt="${escapeHtml(p.nombre)}" width="500" height="500" class="w-full h-full object-contain p-4 sm:p-6 lg:p-5 transition-transform duration-300 group-hover:scale-[1.03] ${sinStock ? 'grayscale opacity-50' : ''}" loading="lazy" decoding="async">
                ${sinStock ? `
                <span class="absolute top-2 left-2 bg-gray-700 text-white text-[8px] sm:text-[9px] font-bold px-2 py-1 rounded uppercase tracking-wide">Sin stock</span>`
                : (esProductoNuevoVigente(p) ? `
                <span class="absolute top-2 left-2 bg-[#3483fa] text-white text-[8px] sm:text-[9px] font-bold px-2 py-1 rounded uppercase tracking-wide">Nuevo</span>` : '')}
            </div>
            <div class="px-2.5 sm:px-3.5 pt-2 sm:pt-3 pb-3 sm:pb-4 flex flex-col flex-1 ${sinStock ? 'opacity-60' : ''}">
                <div class="flex items-center gap-1.5 mb-1.5 flex-shrink-0">
                    ${avatarTienda}
                    <span class="text-gray-500 text-[9px] sm:text-[11px] font-medium uppercase tracking-wide truncate">${escapeHtml(tienda)}</span>
                </div>
                <h3 class="font-normal text-gray-800 text-[13px] sm:text-base leading-snug group-hover:text-[#3483fa] transition-colors min-h-[2.4em] sm:min-h-[2.6em] line-clamp-2">${escapeHtml(p.nombre)}</h3>

                <div class="mt-2 sm:mt-3">
                    ${descuentoPct > 0 ? `<div class="text-[11px] sm:text-xs text-gray-400 line-through leading-none">${formatoPrecio(p.precio_anterior)}</div>` : ''}
                    <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap mt-0.5">
                        <span class="font-medium text-gray-900 text-lg sm:text-2xl leading-none">${formatoPrecio(p.precio)}</span>
                        ${descuentoPct > 0 ? `
                            <span class="text-[10px] sm:text-xs font-semibold text-[#00a650]">${descuentoPct}% OFF</span>
                        ` : ''}
                    </div>
                </div>

                <span class="text-[9px] sm:text-[10px] font-medium text-gray-400 uppercase tracking-wide truncate mt-auto pt-2">${p.categorias ? escapeHtml(p.categorias.nombre) : 'General'}</span>
            </div>
        </div>
    `;
}

// Renderiza la grilla de productos SIN parpadeo: en vez de tirar todo el
// HTML y reconstruirlo entero (lo cual hacía que TODAS las cards
// desaparecieran y reaparecieran ante cualquier cambio -aunque fuera de un
// solo producto de un solo emprendedor-, algo muy molesto en un sitio
// multicliente donde varios emprendedores editan al mismo tiempo), se hace
// un diff contra lo que ya está en el DOM:
//   - Card que no cambió -> se deja intacta (no se toca el nodo, no hay
//     parpadeo ni recarga de imagen).
//   - Card que cambió (precio, foto, etc) -> se reemplaza solo esa.
//   - Producto nuevo -> se agrega.
//   - Producto que ya no está (se ocultó/borró/no pasa el filtro) -> se saca.
// También se reordena si cambió el orden, moviendo nodos existentes en vez
// de recrearlos.
function mostrarProductos(lista) {
    const contenedor = document.getElementById('contenedor-productos');

    if (lista.length === 0) {
        contenedor.dataset.vacio = '1';

        // Dos escenarios muy distintos comparten "lista vacía", y merecen
        // avisos distintos:
        //  1) Catálogo realmente vacío (todavía no hay productos cargados
        //     en toda la web, sin importar filtros): no tiene sentido
        //     mostrar un ícono de "búsqueda sin resultados" ni un botón
        //     de "limpiar filtros" que no cambia nada. Mostramos un aviso
        //     de bienvenida/expectativa, para llamar la atención en lugar
        //     de parecer un error.
        //  2) Hay productos en la web, pero los filtros/búsqueda activos
        //     no matchean ninguno: ahí sí tiene sentido el aviso de "sin
        //     resultados" + limpiar filtros.
        const idsPendientes = new Set(productosNuevosPendientes.map(p => String(p.id)));
        const hayProductosEnLaWeb = productos.some(p => !idsPendientes.has(String(p.id)));

        if (!hayProductosEnLaWeb) {
            contenedor.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center text-center py-20">
                    <span class="w-16 h-16 rounded-full bg-yellow-50 flex items-center justify-center mb-5">
                        <svg class="w-7 h-7 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25v3M14 11.25v3M3.375 7.5h17.25M8.25 7.5V6a2.25 2.25 0 012.25-2.25h3A2.25 2.25 0 0115.75 6v1.5" />
                        </svg>
                    </span>
                    <p class="font-black text-sm uppercase tracking-widest">Sin productos por ahora</p>
                    <p class="text-gray-400 text-xs mt-1.5 max-w-[16rem]">Nuestros emprendedores están armando su catálogo. ¡Muy pronto vas a encontrar productos acá!</p>
                </div>`;
            return;
        }

        contenedor.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center text-center py-20">
                <span class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-5">
                    <svg class="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                        <path stroke-linecap="round" d="M9.3 9.3l3.4 3.4m0-3.4l-3.4 3.4" />
                    </svg>
                </span>
                <p class="font-black text-sm uppercase tracking-widest">Sin resultados</p>
                <p class="text-gray-400 text-xs mt-1.5 max-w-[15rem]">No encontramos productos con esos filtros. Probá con otra categoría, tienda o búsqueda.</p>
                <button onclick="limpiarFiltros()" class="mt-6 border-2 border-black px-6 py-2.5 rounded-full font-bold uppercase text-xs tracking-widest hover:bg-black hover:text-white transition-all active:scale-95">
                    Limpiar filtros
                </button>
            </div>`;
        return;
    }

    // Si veníamos del estado "sin resultados" (o la grilla estaba vacía),
    // no hay nada que diffear: se dibuja todo de una.
    // Primer render real: contenedor vacío, veniamos del estado "sin
    // resultados", o todavía está el skeleton de carga puesto a mano en el
    // HTML (divs con cp-skeleton que no tienen data-producto-id). En
    // cualquiera de esos casos no hay nada válido para diffear: se pisa todo.
    const esSkeletonOEstadoInicial = Array.from(contenedor.children).some(
        el => !el.dataset || !el.dataset.productoId
    );
    if (contenedor.dataset.vacio === '1' || contenedor.children.length === 0 || esSkeletonOEstadoInicial) {
        contenedor.dataset.vacio = '0';
        contenedor.innerHTML = lista.map(p => crearCardHtmlProducto(p)).join('');
        return;
    }

    const existentes = new Map();
    Array.from(contenedor.children).forEach(el => {
        if (el.dataset && el.dataset.productoId) existentes.set(el.dataset.productoId, el);
    });

    let anchorAnterior = null;
    lista.forEach(p => {
        const id = String(p.id);
        let el = existentes.get(id);

        if (el) {
            existentes.delete(id);
            const wrapper = document.createElement('div');
            wrapper.innerHTML = crearCardHtmlProducto(p);
            const nuevoEl = wrapper.firstElementChild;
            if (el.dataset.hash !== nuevoEl.dataset.hash) {
                el.replaceWith(nuevoEl);
                el = nuevoEl;
            }
        } else {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = crearCardHtmlProducto(p);
            el = wrapper.firstElementChild;
        }

        // Ubica el nodo en su posición correcta sin recrearlo (mover un nodo
        // ya existente no dispara ni parpadeo ni recarga de su imagen).
        const siguienteEsperado = anchorAnterior ? anchorAnterior.nextSibling : contenedor.firstChild;
        if (siguienteEsperado !== el) {
            contenedor.insertBefore(el, siguienteEsperado);
        }
        anchorAnterior = el;
    });

    // Lo que quedó en `existentes` ya no está en la lista nueva -> se saca.
    existentes.forEach(el => el.remove());
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
// (miniaturaCloudinary ahora vive en supabase-client.js, compartida con emprendedor.js)

// ============================================================
// FILTROS (categoría + tienda + búsqueda)
// ============================================================
function aplicarFiltros() {
    const textoBusqueda = document.getElementById('buscador').value.toLowerCase();

    // Los productos "nuevos" que llegaron por Realtime y todavía están
    // esperando que el usuario decida (ver aviso) NUNCA se muestran en la
    // grilla, sin importar si vienen de `productos` por una resincronización
    // completa (cargarProductos trae TODO lo activo, pendientes incluidos).
    // Filtrarlos acá -en vez de sacarlos a mano de `productos`- evita que
    // un resync de fondo los "cuele" en la grilla sin que el usuario haya
    // tocado "Ver producto"/"Ver novedades".
    const idsPendientes = new Set(productosNuevosPendientes.map(p => String(p.id)));

    let filtrados = productos.filter(p => !idsPendientes.has(String(p.id)));

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
    if (ordenActivo === 'precio-asc') {
        filtrados.sort((a, b) => Number(a.precio) - Number(b.precio));
    } else if (ordenActivo === 'precio-desc') {
        filtrados.sort((a, b) => Number(b.precio) - Number(a.precio));
    } else if (ordenActivo === 'nombre') {
        filtrados.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    } else {
        filtrados.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    mostrarProductos(filtrados.slice(0, cantidadVisibleProductos));
    actualizarBotonVerMas(filtrados.length);
}

// Muestra/oculta y actualiza el texto del botón "Ver más productos"
// según cuántos productos filtrados quedan sin renderizar todavía.
function actualizarBotonVerMas(totalFiltrados) {
    const wrap = document.getElementById('cp-ver-mas-wrap');
    const contador = document.getElementById('cp-ver-mas-contador');
    if (!wrap) return;

    if (totalFiltrados > cantidadVisibleProductos) {
        wrap.classList.remove('hidden');
        wrap.classList.add('flex');
        const mostrados = Math.min(cantidadVisibleProductos, totalFiltrados);
        if (contador) contador.textContent = `Mostrando ${mostrados} de ${totalFiltrados} productos`;
    } else {
        wrap.classList.add('hidden');
        wrap.classList.remove('flex');
    }
}

// Agranda el lote visible y vuelve a aplicar los filtros actuales (sin
// resetear la cantidad visible, a diferencia de cuando cambian los
// filtros/búsqueda/orden).
function verMasProductos() {
    cantidadVisibleProductos += CP_LOTE_PRODUCTOS;
    aplicarFiltros();
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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
        <div class="w-full flex items-center gap-3 px-3.5 py-3">
            <div class="cp-skeleton w-11 h-11 rounded-xl flex-shrink-0"></div>
            <div class="flex-1 min-w-0 space-y-1.5">
                <div class="cp-skeleton h-3 rounded w-3/4"></div>
                <div class="cp-skeleton h-2 rounded w-1/3"></div>
            </div>
            <div class="cp-skeleton h-3 w-10 rounded flex-shrink-0"></div>
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
    cantidadVisibleProductos = CP_LOTE_PRODUCTOS;
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

    const modalImg = document.getElementById('modal-img');
    modalImg.src = p.imagen_url || '';
    document.getElementById('modal-nombre').innerText = p.nombre;
    const modalTienda = document.getElementById('modal-tienda');
    modalTienda.innerText = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    modalTienda.onclick = () => abrirPerfilEmprendedor(p.emprendedores ? p.emprendedores.id : '');
    document.getElementById('modal-ver-perfil-nombre').innerText = p.emprendedores ? p.emprendedores.nombre_tienda : 'la tienda';
    document.getElementById('modal-ver-perfil').onclick = () => abrirPerfilEmprendedor(p.emprendedores ? p.emprendedores.id : '');
    document.getElementById('modal-desc').innerText = p.descripcion || 'Sin descripción disponible.';

    const modalCategoria = document.getElementById('modal-categoria');
    if (modalCategoria) modalCategoria.innerText = p.categorias ? p.categorias.nombre : 'General';
    const modalBadgeNuevo = document.getElementById('modal-badge-nuevo');
    const sinStock = p.activo === false;
    // Mismo tratamiento visual que la card de la grilla (ver crearCardHtmlProducto):
    // imagen en blanco y negro y semi-transparente cuando el producto está sin stock.
    modalImg.classList.toggle('grayscale', sinStock);
    modalImg.classList.toggle('opacity-50', sinStock);
    if (modalBadgeNuevo) modalBadgeNuevo.classList.toggle('hidden', sinStock || !esProductoNuevoVigente(p));
    const modalBadgeSinStock = document.getElementById('modal-badge-sin-stock');
    if (modalBadgeSinStock) modalBadgeSinStock.classList.toggle('hidden', !sinStock);
    const modalBtnAgregar = document.getElementById('modal-btn-agregar');
    const modalBtnAgregarTexto = document.getElementById('modal-btn-agregar-texto');
    if (modalBtnAgregar) {
        modalBtnAgregar.disabled = sinStock;
        if (modalBtnAgregarTexto) modalBtnAgregarTexto.textContent = sinStock ? 'Sin stock' : 'Agregar al carrito';
    }

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
            // Preseleccionamos una opción con stock si hay alguna; si todas están
            // sin stock, cae en la primera igual (queda visualmente tachada).
            const conStock = opciones.find(o => o.disponible !== false) || opciones[0];
            seleccionVariantes[nombreGrupo] = { valor: conStock.valor, precio_adicional: conStock.precio_adicional };
        }
        return `
            <div>
                <p class="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">${escapeHtml(nombreGrupo)}</p>
                <div class="flex flex-wrap gap-2">
                    ${opciones.map(o => {
                        const sinStock = o.disponible === false;
                        const seleccionado = o.valor === seleccionVariantes[nombreGrupo].valor;
                        return `
                        <button type="button"
                            ${sinStock ? 'disabled' : `onclick="seleccionarVariante('${nombreGrupo.replace(/'/g, "\\'")}', '${o.valor.replace(/'/g, "\\'")}', ${o.precio_adicional || 0})"`}
                            class="variante-opcion px-4 py-2 rounded-full border-2 text-xs font-bold uppercase transition-all ${sinStock ? 'bg-gray-50 text-gray-300 border-gray-200 line-through cursor-not-allowed' : (seleccionado ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-200 hover:border-black')}"
                            data-grupo="${escapeHtml(nombreGrupo)}" data-valor="${escapeHtml(o.valor)}">
                            ${escapeHtml(o.valor)}${o.precio_adicional > 0 ? ' · ' + formatoPrecio(o.precio_adicional) : ''}${sinStock ? ' ' : ''}
                        </button>
                    `;
                    }).join('')}
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

// Precio final del producto según las variantes elegidas: NO se suma nada al
// precio base. Si alguna de las opciones seleccionadas tiene su propio precio
// cargado (ej: "Con caja" -> $60.000), ese precio reemplaza al base. Si más de
// un grupo de variantes tiene precio propio (caso poco común), se usa el más
// alto de todos como precio final.
function calcularPrecioFinalProducto(precioBase, seleccion) {
    const preciosPropios = Object.values(seleccion)
        .map(v => Number(v.precio_adicional) || 0)
        .filter(precio => precio > 0);
    if (preciosPropios.length === 0) return Number(precioBase);
    return Math.max(...preciosPropios);
}

function actualizarPrecioYWhatsapp() {
    const p = productoModalActual;
    if (!p) return;

    const precioFinal = calcularPrecioFinalProducto(p.precio, seleccionVariantes);
    document.getElementById('modal-precio').innerText = formatoPrecio(precioFinal);

    // El precio anterior tachado + % OFF sólo aplica cuando se está cobrando el
    // precio base del producto: si la variante elegida trae su propio precio
    // (reemplaza al base), la oferta del precio base ya no corresponde mostrarla.
    const elPrecioAnterior = document.getElementById('modal-precio-anterior');
    const elBadgeOferta = document.getElementById('modal-badge-oferta');
    const descuentoPct = calcularDescuentoPorcentaje(p.precio_anterior, p.precio);
    const mostrarOferta = descuentoPct > 0 && precioFinal === Number(p.precio);
    if (elPrecioAnterior && elBadgeOferta) {
        if (mostrarOferta) {
            elPrecioAnterior.innerText = formatoPrecio(p.precio_anterior);
            elPrecioAnterior.classList.remove('hidden');
            elBadgeOferta.innerText = `-${descuentoPct}% OFF`;
            elBadgeOferta.classList.remove('hidden');
        } else {
            elPrecioAnterior.classList.add('hidden');
            elBadgeOferta.classList.add('hidden');
        }
    }

    const detalleVariantes = Object.entries(seleccionVariantes)
        .map(([grupo, v]) => `${grupo}: ${v.valor}`)
        .join(', ');

    const tienda = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    const whatsapp = p.emprendedores ? p.emprendedores.whatsapp : '';
    let msg = `Hola ${tienda}, vi tu producto "${p.nombre}" en Comunidad Emprendedora tu mercado virtual y quiero más info!`;
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
        wrap.classList.remove('inline-flex');
        return;
    }

    wrap.classList.remove('hidden');
    wrap.classList.add('inline-flex');
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
    // Si el modal de medios de pago o el lightbox de imagen quedaron
    // abiertos encima, los cerramos primero para no dejar el contador
    // de bloqueo de scroll desincronizado.
    const modalMediosPago = document.getElementById('modal-medios-pago-modal');
    if (modalMediosPago && !modalMediosPago.classList.contains('hidden')) {
        cerrarModalMediosPago();
    }

    const lightboxImagen = document.getElementById('lightbox-imagen');
    if (lightboxImagen && !lightboxImagen.classList.contains('hidden')) {
        cerrarLightboxImagen();
    }

    document.getElementById('modal-producto-overlay').classList.remove('abierto');
    document.getElementById('modal-producto').classList.remove('abierto');
    desbloquearScrollBody();
    productoModalActual = null;
}

// ============================================================
// LIGHTBOX: imagen de producto ampliada (se abre desde el modal
// de producto al hacer clic/tap sobre la foto). Soporta zoom con
// pinch (táctil), rueda del mouse, doble clic/doble tap, y
// desplazamiento (pan) arrastrando con el dedo o el mouse.
// ============================================================
const _LB_ESCALA_MIN = 1;
const _LB_ESCALA_MAX = 4;
const _LB_ESCALA_DOBLE_TAP = 2.5;

let _lbEscala = 1;
let _lbTraslX = 0;
let _lbTraslY = 0;
let _lbPuntero = new Map();      // pointerId -> {x, y} activos
let _lbInicioPan = null;         // {x, y, tx, ty} del gesto de arrastre actual
let _lbDistanciaPrevia = null;   // distancia entre 2 dedos (pinch)
let _lbUltimoTapHora = 0;
let _lbUltimoTapPos = null;
let _lbTapTimeoutId = null;

function abrirLightboxImagen() {
    const p = productoModalActual;
    if (!p || !p.imagen_url) return;

    const lightbox = document.getElementById('lightbox-imagen');
    const overlay = document.getElementById('lightbox-imagen-overlay');
    const img = document.getElementById('lightbox-imagen-img');

    img.src = p.imagen_url;
    img.alt = p.nombre || '';
    const titulo = document.getElementById('lightbox-imagen-titulo');
    if (titulo) titulo.textContent = p.nombre || '';

    _lbReiniciarEstadoZoom();

    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    bloquearScrollBody();

    // Forzamos reflow para que la transición de entrada se dispare
    requestAnimationFrame(() => {
        lightbox.classList.add('abierto');
        overlay.classList.add('abierto');
        img.classList.add('abierto');
    });

    document.addEventListener('keydown', _cerrarLightboxImagenConEsc);
}

function cerrarLightboxImagen() {
    const lightbox = document.getElementById('lightbox-imagen');
    const overlay = document.getElementById('lightbox-imagen-overlay');
    const img = document.getElementById('lightbox-imagen-img');

    overlay.classList.remove('abierto');
    img.classList.remove('abierto');
    lightbox.classList.remove('abierto');

    desbloquearScrollBody();
    document.removeEventListener('keydown', _cerrarLightboxImagenConEsc);
    _lbReiniciarEstadoZoom();

    setTimeout(() => {
        lightbox.classList.add('hidden');
        lightbox.classList.remove('flex');
        img.src = '';
    }, 400);
}

function _cerrarLightboxImagenConEsc(e) {
    if (e.key === 'Escape') cerrarLightboxImagen();
}

// ------------------------------------------------------------
// Estado de zoom/pan
// ------------------------------------------------------------
function _lbReiniciarEstadoZoom() {
    _lbEscala = 1;
    _lbTraslX = 0;
    _lbTraslY = 0;
    _lbPuntero.clear();
    _lbInicioPan = null;
    _lbDistanciaPrevia = null;
    if (_lbTapTimeoutId) { clearTimeout(_lbTapTimeoutId); _lbTapTimeoutId = null; }
    _lbUltimoTapHora = 0;
    _lbUltimoTapPos = null;

    const img = document.getElementById('lightbox-imagen-img');
    if (img) {
        img.classList.remove('lb-transicion');
        img.style.transform = 'translate3d(0,0,0) scale(1)';
        img.style.cursor = 'zoom-in';
    }
    _lbActualizarBotonReset();
}

function _lbAplicarTransform() {
    const img = document.getElementById('lightbox-imagen-img');
    if (!img) return;
    img.style.transform = `translate3d(${_lbTraslX}px, ${_lbTraslY}px, 0) scale(${_lbEscala})`;
}

// Evita que el usuario arrastre la imagen fuera de la pantalla cuando
// está ampliada, dejándola siempre "cubriendo" el visor.
function _lbLimitarTraslado() {
    const img = document.getElementById('lightbox-imagen-img');
    if (!img) return;
    const anchoBase = img.offsetWidth;
    const altoBase = img.offsetHeight;
    const maxX = Math.max(0, (anchoBase * _lbEscala - anchoBase) / 2);
    const maxY = Math.max(0, (altoBase * _lbEscala - altoBase) / 2);
    _lbTraslX = Math.min(maxX, Math.max(-maxX, _lbTraslX));
    _lbTraslY = Math.min(maxY, Math.max(-maxY, _lbTraslY));
}

function _lbActualizarBotonReset() {
    const btn = document.getElementById('lightbox-zoom-reset');
    if (!btn) return;
    const enEscalaBase = _lbEscala <= 1.01;
    btn.textContent = Math.round(_lbEscala * 100) + '%';
    btn.classList.toggle('opacity-40', enEscalaBase);
    btn.classList.toggle('pointer-events-none', enEscalaBase);
}

// Cambia la escala anclando el zoom al punto (anchorX, anchorY) en
// coordenadas de pantalla (cursor, dedo, o centro de la imagen).
function _lbZoomHacia(nuevaEscala, anchorX, anchorY) {
    nuevaEscala = Math.min(_LB_ESCALA_MAX, Math.max(_LB_ESCALA_MIN, nuevaEscala));
    if (nuevaEscala === _lbEscala) return;

    const img = document.getElementById('lightbox-imagen-img');
    if (!img) return;

    const rect = img.getBoundingClientRect();
    const centroX = rect.left + rect.width / 2;
    const centroY = rect.top + rect.height / 2;
    if (anchorX === undefined) anchorX = centroX;
    if (anchorY === undefined) anchorY = centroY;

    const ratio = 1 - (nuevaEscala / _lbEscala);
    _lbTraslX += (anchorX - centroX) * ratio;
    _lbTraslY += (anchorY - centroY) * ratio;

    _lbEscala = nuevaEscala;

    if (_lbEscala <= 1) {
        _lbTraslX = 0;
        _lbTraslY = 0;
    } else {
        _lbLimitarTraslado();
    }

    _lbAplicarTransform();
    img.style.cursor = _lbEscala > 1 ? 'grab' : 'zoom-in';
    _lbActualizarBotonReset();
}

function lightboxZoomIn() {
    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.add('lb-transicion');
    _lbZoomHacia(_lbEscala + 1);
}

function lightboxZoomOut() {
    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.add('lb-transicion');
    _lbZoomHacia(_lbEscala - 1);
}

function lightboxZoomReset() {
    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.add('lb-transicion');
    _lbZoomHacia(1);
}

function _lbToggleZoomEnPunto(x, y) {
    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.add('lb-transicion');
    _lbZoomHacia(_lbEscala > 1 ? 1 : _LB_ESCALA_DOBLE_TAP, x, y);
}

// ------------------------------------------------------------
// Gestos: arrastre (pan) con mouse o un dedo, y pinch con dos dedos.
// Usamos Pointer Events para tratar mouse y táctil de forma unificada.
// ------------------------------------------------------------
function _lbDistanciaEntre(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function _lbPuntoMedio(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function _lbPointerDown(e) {
    const viewport = document.getElementById('lightbox-imagen-viewport');
    if (!viewport) return;
    if (viewport.setPointerCapture) {
        try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }

    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.remove('lb-transicion'); // arrastre/pinch: sin easing, respuesta inmediata

    _lbPuntero.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (_lbPuntero.size === 1) {
        _lbInicioPan = { x: e.clientX, y: e.clientY, tx: _lbTraslX, ty: _lbTraslY };
        if (_lbEscala > 1 && img) img.style.cursor = 'grabbing';
    } else if (_lbPuntero.size === 2) {
        const pts = Array.from(_lbPuntero.values());
        _lbDistanciaPrevia = _lbDistanciaEntre(pts[0], pts[1]);
        _lbInicioPan = null;
    }
}

function _lbPointerMove(e) {
    if (!_lbPuntero.has(e.pointerId)) return;
    _lbPuntero.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (_lbPuntero.size === 2) {
        const pts = Array.from(_lbPuntero.values());
        const distancia = _lbDistanciaEntre(pts[0], pts[1]);
        const medio = _lbPuntoMedio(pts[0], pts[1]);

        if (_lbDistanciaPrevia) {
            const factor = distancia / _lbDistanciaPrevia;
            _lbZoomHacia(_lbEscala * factor, medio.x, medio.y);
        }
        _lbDistanciaPrevia = distancia;
        return;
    }

    if (_lbPuntero.size === 1 && _lbInicioPan && _lbEscala > 1) {
        const dx = e.clientX - _lbInicioPan.x;
        const dy = e.clientY - _lbInicioPan.y;
        _lbTraslX = _lbInicioPan.tx + dx;
        _lbTraslY = _lbInicioPan.ty + dy;
        _lbLimitarTraslado();
        _lbAplicarTransform();
    }
}

function _lbPointerUp(e) {
    const viewport = document.getElementById('lightbox-imagen-viewport');
    if (viewport && viewport.hasPointerCapture && viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
    }

    const eraUnDedo = _lbPuntero.size === 1;
    let semovioPoco = false;
    if (eraUnDedo && _lbInicioPan) {
        const distancia = Math.hypot(e.clientX - _lbInicioPan.x, e.clientY - _lbInicioPan.y);
        semovioPoco = distancia < 6;
    }

    _lbPuntero.delete(e.pointerId);

    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.style.cursor = _lbEscala > 1 ? 'grab' : 'zoom-in';

    if (eraUnDedo && semovioPoco) {
        _lbManejarTap(e.clientX, e.clientY);
    }

    if (_lbPuntero.size === 1) {
        const [restante] = Array.from(_lbPuntero.values());
        _lbInicioPan = { x: restante.x, y: restante.y, tx: _lbTraslX, ty: _lbTraslY };
        _lbDistanciaPrevia = null;
    } else if (_lbPuntero.size === 0) {
        _lbInicioPan = null;
        _lbDistanciaPrevia = null;
    }
}

// Distingue un tap simple (cierra el lightbox si la imagen está en su
// tamaño original) de un doble tap/doble clic (alterna el zoom). El
// cierre se demora unos ms por si llega un segundo tap a tiempo.
function _lbManejarTap(x, y) {
    const ahora = Date.now();
    const distancia = _lbUltimoTapPos ? Math.hypot(x - _lbUltimoTapPos.x, y - _lbUltimoTapPos.y) : Infinity;
    const esDobleTap = (ahora - _lbUltimoTapHora < 300) && (distancia < 40);

    if (esDobleTap) {
        if (_lbTapTimeoutId) { clearTimeout(_lbTapTimeoutId); _lbTapTimeoutId = null; }
        _lbUltimoTapHora = 0;
        _lbUltimoTapPos = null;
        _lbToggleZoomEnPunto(x, y);
        return;
    }

    _lbUltimoTapHora = ahora;
    _lbUltimoTapPos = { x, y };

    if (_lbTapTimeoutId) clearTimeout(_lbTapTimeoutId);
    _lbTapTimeoutId = setTimeout(() => {
        _lbTapTimeoutId = null;
        if (_lbEscala <= 1.01) cerrarLightboxImagen();
    }, 300);
}

// Rueda del mouse (desktop): zoom centrado en la posición del cursor.
function _lbWheel(e) {
    e.preventDefault();
    const img = document.getElementById('lightbox-imagen-img');
    if (img) img.classList.remove('lb-transicion');
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    _lbZoomHacia(_lbEscala * factor, e.clientX, e.clientY);
}

(function _lbInicializarGestos() {
    const viewport = document.getElementById('lightbox-imagen-viewport');
    if (!viewport) return;
    viewport.addEventListener('pointerdown', _lbPointerDown);
    viewport.addEventListener('pointermove', _lbPointerMove);
    viewport.addEventListener('pointerup', _lbPointerUp);
    viewport.addEventListener('pointercancel', _lbPointerUp);
    viewport.addEventListener('wheel', _lbWheel, { passive: false });
})();

// ============================================================
// BLOQUEO DE SCROLL DEL FONDO (a prueba de iOS Safari)
// overflow:hidden solo en el body no alcanza en iOS: el scroll
// "sangra" hacia el contenido de atrás al arrastrar dentro del
// modal. Fijar el body con position:fixed lo evita del todo.
// ============================================================
let _scrollYGuardado = 0;
let _cantidadModalesAbiertos = 0;

// El truco de position:fixed en el body evita que el scroll "sangre" hacia
// atrás en iOS Safari, pero en Chrome/Edge de Windows rompe el scroll por
// gesto de trackpad dentro de los modales (bug conocido de Chromium: con
// el body en position:fixed, el touchpad deja de poder scrollear divs
// anidados con overflow-y:auto, aunque la rueda de un mouse externo sí
// funciona porque dispara un tipo de evento distinto). Por eso el truco
// completo solo se aplica en iOS/iPadOS, que es la única plataforma que
// realmente lo necesita; en el resto alcanza con overflow:hidden.
function _esIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function bloquearScrollBody() {
    if (_cantidadModalesAbiertos === 0) {
        if (_esIOS()) {
            _scrollYGuardado = window.scrollY;
            document.body.style.position = 'fixed';
            document.body.style.top = `-${_scrollYGuardado}px`;
            document.body.style.left = '0';
            document.body.style.right = '0';
        }
        // Se bloquea tanto <html> como <body>: en modo estándar el elemento
        // que realmente scrollea la página es <html> (documentElement), no
        // <body>. Bloquear solo body deja un "scroll exterior" fantasma
        // detrás de los modales (se nota sobre todo en desktop con rueda
        // del mouse fuera del panel).
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        document.body.classList.add('cp-modal-abierto');
    }
    _cantidadModalesAbiertos++;
}

function desbloquearScrollBody() {
    _cantidadModalesAbiertos = Math.max(0, _cantidadModalesAbiertos - 1);
    if (_cantidadModalesAbiertos === 0) {
        if (_esIOS()) {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            window.scrollTo(0, _scrollYGuardado);
        }
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        document.body.classList.remove('cp-modal-abierto');
    }
}

// ============================================================
// DIRECTORIO "VER TODOS" LOS EMPRENDEDORES
// ============================================================
function urlImagenDirectorio(url, tipo) {
    if (!url) return '';
    const marcador = '/upload/';
    const i = url.indexOf(marcador);
    if (i === -1) return url;
    const transform = tipo === 'logo'
        ? 'w_160,h_160,c_pad,b_white,e_trim,q_auto,f_auto'
        : 'w_900,h_320,c_fill,g_center,e_trim,q_auto,f_auto';
    return url.slice(0, i + marcador.length) + transform + '/' + url.slice(i + marcador.length);
}

function chipsMediosPagoDirectorio(ids) {
    const lista = Array.isArray(ids) ? ids : [];
    if (lista.length === 0) {
        return `<span class="text-[10px] font-semibold text-gray-400">Sin medios de pago</span>`;
    }
    const chip = (id, visibilidad) => `
        <span class="${visibilidad} items-center gap-1 bg-gray-50 border border-gray-100 px-2 py-1 rounded-full text-[10px] font-semibold text-gray-600 whitespace-nowrap">
            <span class="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">${iconoMedioPago(id)}</span>
            ${escapeHtml(nombreMedioPago(id))}
        </span>`;
    const primero = lista[0] ? chip(lista[0], 'inline-flex') : '';
    const segundo = lista[1] ? chip(lista[1], 'inline-flex') : '';
    const tercero = lista[2] ? chip(lista[2], 'hidden sm:inline-flex') : '';
    const extraMobile = Math.max(0, lista.length - 2);
    const extraDesktop = Math.max(0, lista.length - 3);
    const mas = extraMobile > 0
        ? `<span class="inline-flex sm:hidden items-center px-2 py-1 rounded-full bg-gray-100 text-[10px] font-black text-gray-500">+${extraMobile}</span>
           ${extraDesktop > 0 ? `<span class="hidden sm:inline-flex items-center px-2 py-1 rounded-full bg-gray-100 text-[10px] font-black text-gray-500">+${extraDesktop}</span>` : ''}`
        : '';
    return primero + segundo + tercero + mas;
}

function renderDirectorioEmprendedores() {
    const cont = document.getElementById('directorio-emprendedores-lista');
    const contador = document.getElementById('directorio-emprendedores-contador');
    if (!cont) return;

    const total = emprendedoresLista.length;
    if (contador) {
        contador.textContent = total === 0
            ? 'Todavía no hay tiendas publicadas'
            : `${total} tienda${total === 1 ? '' : 's'} en la comunidad`;
    }

    if (total === 0) {
        cont.innerHTML = `<p class="col-span-full text-center py-10 text-gray-400 text-sm font-semibold">No hay emprendedores para mostrar.</p>`;
        return;
    }

    cont.innerHTML = emprendedoresLista.map(e => {
        const inicial = e.nombre_tienda ? e.nombre_tienda.charAt(0).toUpperCase() : '?';
        const bannerSrc = urlImagenDirectorio(e.banner_url, 'banner');
        const logoSrc = urlImagenDirectorio(e.logo_url, 'logo');
        const banner = bannerSrc
            ? `<img src="${escapeHtml(bannerSrc)}" alt="" class="absolute inset-0 w-full h-full object-cover">`
            : '';
        const avatarDesktop = logoSrc
            ? `<img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(e.nombre_tienda)}" class="w-16 h-16 rounded-2xl object-contain p-1 bg-white ring-[3px] ring-white shadow-md">`
            : `<span class="w-16 h-16 rounded-2xl bg-black text-white ring-[3px] ring-white shadow-md flex items-center justify-center text-xl font-900">${escapeHtml(inicial)}</span>`;
        const avatarMobile = logoSrc
            ? `<img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(e.nombre_tienda)}" class="w-12 h-12 rounded-xl object-contain p-0.5 bg-white border border-gray-100 flex-shrink-0">`
            : `<span class="w-12 h-12 rounded-xl bg-black text-white flex-shrink-0 flex items-center justify-center text-base font-900">${escapeHtml(inicial)}</span>`;
        const bio = (e.bio || '').trim()
            ? escapeHtml(e.bio)
            : 'Este emprendedor todavía no cargó una descripción.';
        // Va directo a la tienda del emprendedor: acá NO se abre el modal de
        // perfil/elegir (ese solo se usa al clickear el logo en la fila de
        // arriba, ver cargarEmprendedoresFila).
        const slugTienda = e.usuarios && e.usuarios.usuario;
        const hrefTienda = slugTienda
            ? `emprendedor.html?t=${encodeURIComponent(slugTienda)}`
            : `emprendedor.html?id=${encodeURIComponent(e.id)}`;
        return `
            <a href="${hrefTienda}" class="group w-full flex flex-col text-left bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm hover:border-black hover:shadow-xl transition-all active:scale-[0.99]">
                <div class="relative h-16 sm:h-32 flex-shrink-0 overflow-hidden bg-zinc-900">
                    <div class="absolute inset-0" style="background-image: radial-gradient(circle, rgba(255,255,255,0.1) 1.5px, transparent 1.5px); background-size: 16px 16px;"></div>
                    ${banner}
                    <div class="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent pointer-events-none"></div>
                </div>
                <div class="flex flex-row items-start gap-3 p-3 sm:flex-col sm:px-4 sm:pt-0 sm:pb-4 sm:gap-0">
                    <div class="hidden sm:block relative z-10 -mt-8 mb-3">${avatarDesktop}</div>
                    <div class="sm:hidden flex-shrink-0">${avatarMobile}</div>
                    <div class="flex-1 min-w-0 flex flex-col">
                        <h3 class="font-900 uppercase italic leading-tight text-sm sm:text-base truncate">${escapeHtml(e.nombre_tienda)}</h3>
                        <p class="text-gray-500 text-[11px] sm:text-xs leading-snug mt-0.5 sm:mt-1.5 line-clamp-1 sm:line-clamp-2 sm:min-h-[2.5rem]">${bio}</p>
                        <div class="mt-2 sm:mt-auto sm:pt-3 sm:border-t sm:border-gray-100">
                            <div class="flex flex-nowrap overflow-hidden gap-1 sm:flex-wrap sm:gap-1.5">
                                ${chipsMediosPagoDirectorio(e.medios_pago)}
                            </div>
                            <span class="mt-2 sm:mt-3 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-black">
                                Ver productos
                                <svg class="w-3 h-3 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>
                            </span>
                        </div>
                    </div>
                </div>
            </a>
        `;
    }).join('');
}

function abrirDirectorioEmprendedores() {
    renderDirectorioEmprendedores();
    const modal = document.getElementById('modal-directorio-emprendedores');
    if (!modal || !modal.classList.contains('hidden')) return;
    modal.classList.remove('hidden');
    bloquearScrollBody();
}

function cerrarDirectorioEmprendedores() {
    const modal = document.getElementById('modal-directorio-emprendedores');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    desbloquearScrollBody();
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
        if (calcularEstadoAcceso(data).bloqueado) return; // mes gratis/suscripción vencida
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
        const msg = `Hola ${e.nombre_tienda}, te encontré en Comunidad Emprendedora tu mercado virtual!`;
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
// Recorre el carrito y, para los items cuyo precio depende del precio base
// del producto (no de una variante con precio propio), lo actualiza al
// precio actual. Devuelve true si tocó algo (para que el caller sepa si
// tiene que re-renderizar/guardar).
function sincronizarPreciosCarrito() {
    let huboCambios = false;
    carrito.items.forEach(item => {
        // OJO: usaPrecioBase !== false (en vez de "!item.usaPrecioBase") a
        // propósito. Carritos guardados en localStorage ANTES de que este
        // campo existiera no lo tienen (queda undefined); si tratáramos eso
        // como "false" esos items quedaban congelados para siempre en su
        // precio viejo. Tratar "undefined" como "sí, sincronizalo" es el
        // default seguro: la mayoría de los items son de precio base.
        if (item.noDisponible || item.usaPrecioBase === false) return;
        const p = productos.find(pr => String(pr.id) === String(item.productoId));
        if (!p) return;
        const precioActual = Number(p.precio);
        if (!isNaN(precioActual) && precioActual !== item.precioUnitario) {
            item.precioUnitario = precioActual;
            huboCambios = true;
        }
    });
    return huboCambios;
}

function sincronizarDisponibilidadCarrito(mostrarAviso = true) {
    if (carrito.items.length === 0) return [];

    // OJO: ya no alcanza con "está en `productos`", porque ahora los
    // productos sin stock (activo === false) también se cargan y se
    // quedan en memoria (para poder mostrar su card marcada "Sin
    // stock"). Un producto solo está realmente disponible para comprar
    // si además tiene activo === true.
    const idsActivos = new Set(productos.filter(p => p.activo !== false).map(p => String(p.id)));
    const nuevosNoDisponibles = [];
    let huboCambios = false;

    carrito.items.forEach(item => {
        const disponibleAhora = idsActivos.has(String(item.productoId));
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

    // El precio del carrito quedaba "congelado" al valor que tenía cuando
    // se agregó: si el emprendedor editaba el precio del producto después,
    // quien ya lo tenía en el carrito seguía viendo el precio viejo. Acá
    // lo recalculamos para los items cuyo precio depende del precio BASE
    // del producto (item.usaPrecioBase); los que quedaron con un precio
    // fijo por variante (ej: "Con caja" -> $60.000) no se tocan, porque
    // ese precio no depende de `producto.precio` (ver calcularPrecioFinalProducto).
    if (sincronizarPreciosCarrito()) huboCambios = true;

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
    if (p.activo === false) {
        mostrarToast('Este producto está sin stock por el momento.', 'error');
        return;
    }

    const precioUnitario = calcularPrecioFinalProducto(p.precio, seleccionVariantes);
    const variantesTexto = Object.entries(seleccionVariantes).map(([grupo, v]) => `${grupo}: ${v.valor}`).join(', ');
    const itemKey = `${p.id}__${variantesTexto}`;

    // usaPrecioBase: si NINGUNA variante seleccionada tiene precio propio,
    // el precio del item es directamente el precio del producto -> hay que
    // mantenerlo sincronizado si el emprendedor lo edita después (ver
    // sincronizarPreciosCarrito). Si alguna variante sí tiene precio propio,
    // ese precio queda fijo (no depende de producto.precio).
    const usaPrecioBase = Object.values(seleccionVariantes).every(v => !(Number(v.precio_adicional) > 0));

    const nuevoItem = {
        key: itemKey,
        productoId: p.id,
        nombre: p.nombre,
        imagen: p.imagen_url || '',
        precioUnitario,
        usaPrecioBase,
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
    const esCarritoNuevo = carrito.items.length === 0;
    carrito.emprendedorId = emprendedor.id;
    carrito.emprendedorNombre = emprendedor.nombre_tienda;
    carrito.emprendedorWhatsapp = emprendedor.whatsapp || '';
    carrito.costoEnvio = Number(emprendedor.costo_envio) || 0;
    // La modalidad (envío/retiro) se resetea a "envío" sólo al arrancar un
    // carrito nuevo; si el usuario ya eligió "retiro" y sigue agregando
    // productos de la misma tienda, respetamos su elección.
    if (esCarritoNuevo) carrito.envioSeleccionado = true;

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
    carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', costoEnvio: 0, envioSeleccionado: true, items: [] };
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
        carrito.costoEnvio = 0;
        carrito.envioSeleccionado = true;
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
        carrito.costoEnvio = 0;
        carrito.envioSeleccionado = true;
    }
    guardarCarritoEnStorage();
    actualizarBadgeCarrito();
    renderCarrito();
}

function vaciarCarrito() {
    carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', costoEnvio: 0, envioSeleccionado: true, items: [] };
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

function calcularSubtotalCarrito() {
    // Los productos no disponibles no cuentan en el total: no se pueden
    // comprar hasta que el usuario los saque del carrito.
    return carrito.items
        .filter(i => !i.noDisponible)
        .reduce((sum, i) => sum + i.precioUnitario * i.cantidad, 0);
}

function calcularTotalCarrito() {
    const quiereEnvio = carrito.envioSeleccionado !== false;
    return calcularSubtotalCarrito() + (quiereEnvio ? (carrito.costoEnvio || 0) : 0);
}

function seleccionarModalidadEntrega(quiereEnvio) {
    carrito.envioSeleccionado = quiereEnvio;
    guardarCarritoEnStorage();
    renderCarrito();
}

function _marcarBotonModalidad(btn, activo) {
    btn.classList.toggle('bg-black', activo);
    btn.classList.toggle('text-white', activo);
    btn.classList.toggle('border-black', activo);
    btn.classList.toggle('bg-white', !activo);
    btn.classList.toggle('text-gray-500', !activo);
    btn.classList.toggle('border-gray-200', !activo);
}

function renderCarrito() {
    const cont = document.getElementById('carrito-items');
    const subtitulo = document.getElementById('carrito-subtitulo');
    const btnWsp = document.getElementById('carrito-whatsapp-btn');

    if (carrito.items.length === 0) {
        cont.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-center py-16">
                <span class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                    <svg class="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3 3h1.5l1.6 9.6a2 2 0 002 1.65h8.4a2 2 0 002-1.65L20 7.5H6" />
                        <circle cx="9.5" cy="19.5" r="1.4" fill="currentColor" stroke="none"/>
                        <circle cx="16.5" cy="19.5" r="1.4" fill="currentColor" stroke="none"/>
                    </svg>
                </span>
                <p class="font-black text-sm uppercase tracking-widest">Está vacío</p>
                <p class="text-gray-400 text-xs mt-1.5">Todavía no agregaste ningún producto.</p>
                <button onclick="cerrarCarrito()" class="mt-6 border-2 border-black px-6 py-2.5 rounded-full font-bold uppercase text-xs tracking-widest hover:bg-black hover:text-white transition-all active:scale-95">
                    Seguir comprando
                </button>
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
            <div class="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <svg class="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a1 1 0 00.87 1.5h18.62a1 1 0 00.87-1.5L13.71 3.86a1 1 0 00-1.72 0z" />
                </svg>
                <p class="text-[11px] font-bold text-red-500 leading-snug">Tenés productos que ya no están disponibles. Eliminalos del carrito para poder enviar tu pedido.</p>
            </div>` : '';

        cont.innerHTML = bannerNoDisponible + carrito.items.map(i => {
            if (i.noDisponible) {
                return `
            <div class="flex gap-3 items-start bg-gray-50 rounded-2xl p-3">
                <div class="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 grayscale">
                    <img src="${i.imagen}" alt="${escapeHtml(i.nombre)}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-bold text-sm leading-tight truncate line-through text-gray-500">${escapeHtml(i.nombre)}</p>
                    ${i.variantesTexto ? `<p class="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">${escapeHtml(i.variantesTexto)}</p>` : ''}
                    <p class="text-[10px] font-black uppercase tracking-widest text-red-500 mt-1.5">No disponible</p>
                    <button onclick="eliminarDelCarrito('${i.key}')" class="mt-2 text-[10px] font-black uppercase tracking-widest text-white bg-red-500 hover:bg-red-600 transition-colors rounded-full px-3 py-1.5">
                        Eliminar del carrito
                    </button>
                </div>
            </div>`;
            }
            return `
            <div class="flex gap-3 items-start bg-gray-50 rounded-2xl p-3 hover:bg-gray-100/80 transition-colors">
                <div class="w-16 h-16 rounded-xl bg-white overflow-hidden flex-shrink-0 ring-1 ring-black/5">
                    <img src="${i.imagen}" alt="${escapeHtml(i.nombre)}" class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-start justify-between gap-2">
                        <p class="font-bold text-sm leading-tight truncate">${escapeHtml(i.nombre)}</p>
                        <button onclick="eliminarDelCarrito('${i.key}')" aria-label="Quitar producto" class="w-6 h-6 rounded-full text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center flex-shrink-0">
                            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18" />
                            </svg>
                        </button>
                    </div>
                    ${i.variantesTexto ? `<p class="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">${escapeHtml(i.variantesTexto)}</p>` : ''}
                    <div class="flex items-center justify-between mt-2">
                        <div class="flex items-center gap-2 bg-white rounded-full px-1.5 py-0.5 ring-1 ring-black/5">
                            <button onclick="modificarCantidadCarrito('${i.key}', -1)" class="w-6 h-6 rounded-full bg-gray-100 shadow-sm font-black text-sm leading-none hover:bg-yellow-400 transition-all active:scale-90">−</button>
                            <span class="font-black text-xs w-4 text-center">${i.cantidad}</span>
                            <button onclick="modificarCantidadCarrito('${i.key}', 1)" class="w-6 h-6 rounded-full bg-gray-100 shadow-sm font-black text-sm leading-none hover:bg-yellow-400 transition-all active:scale-90">+</button>
                        </div>
                        <span class="font-black text-sm">${formatoPrecio(i.precioUnitario * i.cantidad)}</span>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    const modalidadWrap = document.getElementById('carrito-modalidad-envio');
    const hayEnvioConfigurado = carrito.items.length > 0 && carrito.costoEnvio > 0;
    const quiereEnvio = carrito.envioSeleccionado !== false;

    if (hayEnvioConfigurado) {
        modalidadWrap.classList.remove('hidden');
        _marcarBotonModalidad(document.getElementById('btn-modalidad-envio'), quiereEnvio);
        _marcarBotonModalidad(document.getElementById('btn-modalidad-retiro'), !quiereEnvio);
    } else {
        modalidadWrap.classList.add('hidden');
    }

    const envioAplicado = hayEnvioConfigurado && quiereEnvio ? carrito.costoEnvio : 0;
    const filaSubtotal = document.getElementById('carrito-fila-subtotal');
    const filaEnvio = document.getElementById('carrito-fila-envio');
    if (hayEnvioConfigurado) {
        filaSubtotal.classList.remove('hidden');
        document.getElementById('carrito-subtotal').innerText = formatoPrecio(calcularSubtotalCarrito());
        if (envioAplicado > 0) {
            filaEnvio.classList.remove('hidden');
            document.getElementById('carrito-envio').innerText = formatoPrecio(envioAplicado);
        } else {
            filaEnvio.classList.add('hidden');
        }
    } else {
        filaSubtotal.classList.add('hidden');
        filaEnvio.classList.add('hidden');
    }
    document.getElementById('carrito-total').innerText = formatoPrecio(calcularTotalCarrito());
}

function abrirCarrito() {
    // Mostramos el carrito al instante con lo que ya tenemos en memoria
    // (no hacemos esperar al usuario a que responda la red).
    sincronizarDisponibilidadCarrito();
    renderCarrito();
    document.getElementById('carrito-overlay').classList.remove('hidden');
    document.getElementById('carrito-drawer').classList.remove('translate-x-full');
    bloquearScrollBody();

    // Red de seguridad real: en vez de confiar en que el evento de Realtime
    // ya llegó y actualizó `productos` en memoria (puede no haber llegado
    // todavía, o el canal puede haberse cortado sin que nos diéramos
    // cuenta), le preguntamos directo a Supabase el precio/disponibilidad
    // ACTUAL de los productos que el usuario tiene en el carrito. Si algo
    // cambió, se corrige acá aunque el realtime nunca hubiera avisado.
    refrescarPreciosCarritoDesdeServidor();
}

async function refrescarPreciosCarritoDesdeServidor() {
    if (carrito.items.length === 0) return;

    const ids = [...new Set(carrito.items.map(i => i.productoId))];
    const { data, error } = await supabase
        .from('productos')
        .select('id, precio, activo')
        .in('id', ids);

    if (error || !data) return;

    data.forEach(row => {
        const idx = productos.findIndex(p => String(p.id) === String(row.id));
        if (idx !== -1) {
            productos[idx].precio = Number(row.precio);
            productos[idx].activo = row.activo;
        } else {
            productos.push({ id: row.id, precio: Number(row.precio), activo: row.activo });
        }
    });

    sincronizarDisponibilidadCarrito();
}

function cerrarCarrito() {
    ocultarCarritoVisualmente();
    desbloquearScrollBody();
}

// Muestra/oculta el carrito solo a nivel visual (clases), sin tocar el
// contador de bloqueo de scroll. Se usa para poder tapar el carrito detrás
// del modal de QR sin desincronizar bloquearScrollBody()/desbloquearScrollBody().
function ocultarCarritoVisualmente() {
    document.getElementById('carrito-overlay').classList.add('hidden');
    document.getElementById('carrito-drawer').classList.add('translate-x-full');
}

function mostrarCarritoVisualmente() {
    document.getElementById('carrito-overlay').classList.remove('hidden');
    document.getElementById('carrito-drawer').classList.remove('translate-x-full');
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

// Detecta si estamos en un celular/tablet (vs. PC). En PC no tiene sentido
// abrir wa.me directo porque es difícil que el usuario tenga WhatsApp
// abierto ahí; en ese caso mostramos un QR para escanear con el celular.
function esDispositivoMobile() {
    const ua = navigator.userAgent;
    const uaMobile = /Android|iPhone|iPod|Windows Phone|Mobile/i.test(ua);

    // iPadOS (13+) manda un user agent idéntico al de una Mac de escritorio
    // ("Macintosh...", sin "iPad" ni "Mobile"), así que el chequeo de arriba
    // no lo detecta. Se delata porque, a diferencia de una Mac real, tiene
    // pantalla táctil (maxTouchPoints > 1). Cubrimos también el "iPad" viejo
    // por las dudas (versiones de iPadOS/Safari que sí lo incluyen en la UA).
    const esIPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

    // Cualquier otra tablet/dispositivo con pantalla táctil como entrada
    // principal (sin mouse), aunque su UA no traiga ninguna palabra clave.
    const esTactilComoPrincipal = window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;

    const pantallaChica = window.matchMedia('(max-width: 767px)').matches;

    return uaMobile || esIPad || (esTactilComoPrincipal && pantallaChica);
}

// Vacía el carrito y cierra su drawer, dejando todo listo para una nueva
// compra. Se usa después de que el pedido ya se mandó (o se asume mandado).
function finalizarPedido() {
    vaciarCarrito();
    cerrarCarrito();
}

// Guarda el link de WhatsApp Web del pedido actualmente mostrado en el
// modal de QR, para el botón "Ya tengo WhatsApp Web abierto".
let _qrPedidoUrlWhatsappWeb = null;

// Muestra el QR (PC) que al escanearlo desde el celular abre WhatsApp con
// el pedido ya redactado. Mientras se genera, se ve un loader. También deja
// lista la alternativa de WhatsApp Web, por si ya lo tienen abierto en la PC.
function mostrarModalQrPedido(telefono, mensaje) {
    const urlWaMe = `https://wa.me/${telefono}?text=${encodeURIComponent(mensaje)}`;
    _qrPedidoUrlWhatsappWeb = `https://web.whatsapp.com/send?phone=${telefono}&text=${encodeURIComponent(mensaje)}`;

    const cont = document.getElementById('qr-pedido-canvas');
    cont.innerHTML = `
        <div class="flex flex-col items-center gap-3 text-gray-300">
            <svg class="w-10 h-10 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="9" stroke-opacity="0.25"></circle>
                <path d="M21 12a9 9 0 00-9-9" stroke-linecap="round"></path>
            </svg>
            <span class="text-[10px] font-black uppercase tracking-widest text-gray-400">Cargando QR...</span>
        </div>
    `;

    // El modal de QR se abre siempre desde el carrito, que ya está abierto
    // (y ya bloqueó el scroll) atrás. Antes acá quedaban DOS overlays
    // semitransparentes superpuestos (el del carrito + el del QR), cada uno
    // haciendo blending en vivo sobre el contenido de atrás (que tiene
    // animaciones corriendo, como los skeletons con shimmer): eso es lo que
    // generaba el lag al abrir/mover el modal en PC. Ocultamos el carrito
    // SOLO visualmente (sin tocar el contador de bloqueo de scroll, que
    // sigue representando que "algo" sigue abierto) para que quede un único
    // overlay en pantalla.
    ocultarCarritoVisualmente();

    document.getElementById('modal-qr-pedido').classList.remove('hidden');
    bloquearScrollBody();

    if (typeof QRCode === 'undefined') {
        console.error('No se pudo cargar qrcode.min.js (revisá que el archivo esté subido junto a index.html)');
        cont.innerHTML = '<span class="text-[11px] font-bold text-red-500 px-3 leading-snug">No pudimos generar el QR</span>';
        return;
    }

    const opcionesQr = { margin: 1, errorCorrectionLevel: 'L' };

    // Generamos el QR como SVG (texto vectorial) en vez de <canvas>: en
    // algunas tablets Android con WebViews viejos o con la aceleración por
    // hardware limitada, crear/dibujar sobre un <canvas> falla (por eso el
    // QR nunca se veía ahí, aunque en PC funcionara perfecto). El SVG no
    // depende del motor 2D del navegador, así que es mucho más compatible.
    // Si por algo raro también fallara, probamos con canvas como respaldo.
    QRCode.toString(urlWaMe, { ...opcionesQr, type: 'svg' }, (errorSvg, svg) => {
        if (!errorSvg) {
            cont.innerHTML = svg;
            const svgEl = cont.querySelector('svg');
            if (svgEl) {
                svgEl.setAttribute('width', '260');
                svgEl.setAttribute('height', '260');
                svgEl.style.display = 'block';
            }
            return;
        }

        console.error('No se pudo generar el QR como SVG, probando con canvas', errorSvg);
        QRCode.toCanvas(urlWaMe, { width: 260, ...opcionesQr }, (errorCanvas, canvas) => {
            if (errorCanvas) {
                console.error('No se pudo generar el QR del pedido', errorCanvas);
                cont.innerHTML = '<span class="text-[11px] font-bold text-red-500 px-3 leading-snug">No pudimos generar el QR</span>';
                return;
            }
            cont.innerHTML = '';
            cont.appendChild(canvas);
        });
    });
}

// Botón "Ya tengo WhatsApp Web abierto": abre WhatsApp Web en una pestaña
// nueva con el pedido ya redactado, para quienes no necesitan el QR. Damos
// el pedido por enviado: cerramos el modal y vaciamos el carrito, igual que
// con "Ya envié el pedido".
function abrirWhatsappWebPedido() {
    if (!_qrPedidoUrlWhatsappWeb) return;
    window.open(_qrPedidoUrlWhatsappWeb, '_blank');
    document.getElementById('modal-qr-pedido').classList.add('hidden');
    desbloquearScrollBody();
    _qrPedidoUrlWhatsappWeb = null;
    finalizarPedido();
}

// Antes de dejar salir del modal de QR (X o click afuera), confirma si el
// pedido ya se envió o no. Si todavía no se mandó, el modal se queda
// abierto para no perder el QR sin querer.
async function intentarCerrarModalQr() {
    const yaEnvio = await confirmarAccion(
        '¿Ya enviaste tu pedido por WhatsApp?',
        {
            titulo: 'Antes de salir',
            textoConfirmar: 'Sí, ya lo envié',
            textoCancelar: 'Todavía no',
            peligro: false,
        }
    );
    if (yaEnvio) {
        confirmarPedidoEnviadoDesdeQr();
    }
    // Si dice que todavía no lo envió, no hacemos nada: el QR sigue abierto.
}

function cerrarModalQrPedido() {
    document.getElementById('modal-qr-pedido').classList.add('hidden');
    desbloquearScrollBody();
    _qrPedidoUrlWhatsappWeb = null;
    finalizarPedido(); // finalizarPedido() -> cerrarCarrito() se encarga de ocultar el carrito y liberar su propio bloqueo de scroll.
}

// Botón "Ya envié el pedido" dentro del modal de QR.
function confirmarPedidoEnviadoDesdeQr() {
    document.getElementById('modal-qr-pedido').classList.add('hidden');
    desbloquearScrollBody();
    _qrPedidoUrlWhatsappWeb = null;
    finalizarPedido();
}

// Botón "Me olvidé de agregar algo": vuelve al carrito SIN vaciarlo y sin
// dar el pedido por enviado, para que el usuario agregue lo que le faltaba.
// Al tocar "Enviar pedido" de nuevo, se genera un QR nuevo con todo incluido.
function volverAlCarritoDesdeQr() {
    document.getElementById('modal-qr-pedido').classList.add('hidden');
    // Este desbloquearScrollBody() libera SOLO el bloqueo que agregó el modal
    // de QR. El del carrito (que nunca se cerró, solo se ocultó visualmente
    // en mostrarModalQrPedido) sigue en pie, así que NO hay que volver a
    // llamar bloquearScrollBody() acá.
    desbloquearScrollBody();
    _qrPedidoUrlWhatsappWeb = null;

    // En vez de abrirCarrito() (que volvería a bloquear el scroll y
    // desincronizaría el contador contra el desbloquearScrollBody() de
    // arriba, dejando el scroll trabado para siempre después de cerrar el
    // carrito), mostramos el carrito de nuevo y refrescamos sus datos "a
    // mano", sin tocar el bloqueo de scroll.
    mostrarCarritoVisualmente();
    sincronizarDisponibilidadCarrito();
    renderCarrito();
    refrescarPreciosCarritoDesdeServidor();
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
        .select('id, activo, emprendedores!inner(activo, created_at, suscripcion_estado, fecha_vencimiento_suscripcion)')
        .in('id', idsCarrito);

    if (!errorVigencia && vigentes) {
        const idsVigentes = new Set(
            vigentes
                .filter(p => p.activo && p.emprendedores && !calcularEstadoAcceso(p.emprendedores).bloqueado)
                .map(p => p.id)
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
    const quiereEnvioMsg = carrito.envioSeleccionado !== false;

    let msg = `Hola ${carrito.emprendedorNombre}! Quiero hacer este pedido desde Comunidad Emprendedora tu mercado virtual:\n\n`;
    if (carrito.costoEnvio > 0) {
        msg += `Modalidad de entrega: ${quiereEnvioMsg ? 'Envío a domicilio' : 'Retiro en el local'}\n\n`;
    }
    carrito.items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.nombre}`;
        if (i.variantesTexto) msg += ` (${i.variantesTexto})`;
        msg += ` x${i.cantidad} - ${formatoPrecio(i.precioUnitario * i.cantidad)}\n`;
        if (i.productoId) msg += `   ${baseUrl}?producto=${i.productoId}\n`;
    });
    const envioMsg = quiereEnvioMsg ? (carrito.costoEnvio || 0) : 0;
    if (envioMsg > 0) {
        msg += `\nSubtotal: ${formatoPrecio(calcularSubtotalCarrito())}`;
        msg += `\nEnvío: ${formatoPrecio(envioMsg)}`;
    }
    msg += `\nTotal: ${formatoPrecio(calcularTotalCarrito())}`;

    if (esDispositivoMobile()) {
        // En el celular el link abre WhatsApp directo: mandamos el pedido
        // y dejamos el carrito listo para una compra nueva.
        const urlWhatsapp = `https://wa.me/${carrito.emprendedorWhatsapp}?text=${encodeURIComponent(msg)}`;
        window.open(urlWhatsapp, '_blank');
        finalizarPedido();
    } else {
        // En PC mostramos un QR (y la alternativa de WhatsApp Web): el
        // carrito se vacía recién cuando cierra el modal o confirma el envío.
        mostrarModalQrPedido(carrito.emprendedorWhatsapp, msg);
    }
}

// ============================================================
// BOTÓN "VOLVER ARRIBA": aparece recién después de scrollear
// ============================================================
(function () {
    const btnScrollTop = document.getElementById('btn-scroll-top');
    if (!btnScrollTop) return;

    function actualizarVisibilidadBtnScrollTop() {
        const debeMostrarse = window.scrollY > 400;
        btnScrollTop.classList.toggle('opacity-0', !debeMostrarse);
        btnScrollTop.classList.toggle('pointer-events-none', !debeMostrarse);
        btnScrollTop.classList.toggle('translate-y-3', !debeMostrarse);
    }

    window.addEventListener('scroll', actualizarVisibilidadBtnScrollTop, { passive: true });
    actualizarVisibilidadBtnScrollTop();
})();

// ============================================================
// POSTULACIÓN ("Quiero vender"): formulario público, por pasos,
// para emprendedores y comercios (venta de productos o
// membresía). Se guarda en la tabla `postulaciones` y el admin
// la gestiona desde admin.html -> sección "Postulación".
// ============================================================
let postulacionTipoElegido = null; // 'emprendedor' | 'comercio_vender' | 'comercio_membresia'

// Antes el título del modal se armaba concatenando texto ("Quiero vender ·
// Comercio") en un solo <h2> con `truncate`, y en pantallas chicas el texto
// se cortaba con "…" a mitad de palabra. Ahora el título queda siempre fijo
// y corto, y el tipo de perfil elegido se muestra aparte como un tag chico
// al lado (ver .cp-postmodal__tag en el <style> de index.html).
function setTituloPostulacion(titulo, tag) {
    document.getElementById('postulacion-titulo').textContent = titulo;
    const elTag = document.getElementById('postulacion-subtitulo');
    if (tag) {
        elTag.textContent = tag;
        elTag.classList.remove('hidden');
    } else {
        elTag.classList.add('hidden');
    }
}

function abrirModalPostulacion() {
    postulacionTipoElegido = null;
    document.getElementById('form-postulacion').reset();
    document.getElementById('form-postulacion').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.remove('flex');
    document.getElementById('postulacion-paso-exito').classList.add('hidden');
    document.getElementById('postulacion-paso-comercio').classList.add('hidden');
    document.getElementById('postulacion-paso-tipo').classList.remove('hidden');
    setTituloPostulacion('Quiero vender');

    document.getElementById('modal-postulacion').classList.remove('hidden');
    bloquearScrollBody();
}

function cerrarModalPostulacion() {
    document.getElementById('modal-postulacion').classList.add('hidden');
    desbloquearScrollBody();
}

function elegirTipoPostulacion(tipo) {
    if (tipo === 'emprendedor') {
        iniciarFormularioPostulacion('emprendedor');
        return;
    }
    // comercio: preguntamos el interés puntual antes de mostrar el formulario
    document.getElementById('postulacion-paso-tipo').classList.add('hidden');
    document.getElementById('postulacion-paso-comercio').classList.remove('hidden');
    setTituloPostulacion('Quiero vender', 'Comercio');
}

function volverAPasoTipoPostulacion() {
    document.getElementById('postulacion-paso-comercio').classList.add('hidden');
    document.getElementById('postulacion-paso-tipo').classList.remove('hidden');
    setTituloPostulacion('Quiero vender');
}

function elegirInteresComercio(interes) {
    iniciarFormularioPostulacion(interes);
}

// Vuelve del formulario (paso 1) a la pantalla de selección anterior.
function volverDesdeFormularioPostulacion() {
    document.getElementById('form-postulacion').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.remove('flex');

    if (postulacionTipoElegido === 'emprendedor') {
        document.getElementById('postulacion-paso-tipo').classList.remove('hidden');
        setTituloPostulacion('Quiero vender');
    } else {
        document.getElementById('postulacion-paso-comercio').classList.remove('hidden');
        setTituloPostulacion('Quiero vender', 'Comercio');
    }
}

// Ajusta las etiquetas del formulario según el perfil elegido y muestra el paso 1.
function iniciarFormularioPostulacion(tipo) {
    postulacionTipoElegido = tipo;
    document.getElementById('post-tipo').value = tipo;

    const titulos = {
        emprendedor: ['Quiero vender', 'Emprendedor'],
        comercio_vender: ['Quiero vender', 'Comercio'],
        comercio_membresia: ['Membresía', 'Comercio'],
    };
    const [titulo, tag] = titulos[tipo] || ['Quiero vender', null];
    setTituloPostulacion(titulo, tag);

    const esComercio = tipo !== 'emprendedor';
    document.getElementById('post-label-negocio').textContent = esComercio ? 'Nombre del comercio' : 'Nombre de tu emprendimiento';
    document.getElementById('post-negocio').placeholder = esComercio ? 'Ej: Almacén del Centro' : 'Ej: Velas Lumen';
    document.getElementById('post-label-categoria').textContent = esComercio ? 'Rubro del comercio' : 'Rubro / categoría';
    document.getElementById('postulacion-form-paso-2-intro').textContent = esComercio ? 'Contanos sobre tu comercio.' : 'Contanos sobre tu emprendimiento.';

    if (tipo === 'comercio_membresia') {
        document.getElementById('post-label-mensaje').textContent = 'Contanos sobre tu comercio';
        document.getElementById('post-mensaje').placeholder = 'Qué tipo de comercio tenés y qué te interesa de la membresía.';
    } else {
        document.getElementById('post-label-mensaje').textContent = 'Contanos un poco más';
        document.getElementById('post-mensaje').placeholder = 'Qué productos ofrecés, hace cuánto emprendés, etc.';
    }

    document.getElementById('postulacion-paso-tipo').classList.add('hidden');
    document.getElementById('postulacion-paso-comercio').classList.add('hidden');
    document.getElementById('form-postulacion').classList.remove('hidden');

    const progreso = document.getElementById('postulacion-progreso');
    progreso.classList.remove('hidden');
    progreso.classList.add('flex');

    irAPasoFormulario(1);
}

// Cambia entre el paso 1 (datos personales) y el paso 2 (datos del negocio)
// dentro del formulario, validando el paso 1 antes de avanzar.
function irAPasoFormulario(paso) {
    if (paso === 2) {
        const nombre = document.getElementById('post-nombre');
        const whatsapp = document.getElementById('post-whatsapp');
        const email = document.getElementById('post-email');
        if (!nombre.value.trim() || !whatsapp.value.trim() || !email.value.trim()) {
            mostrarToast('Completá tu nombre, WhatsApp y email para continuar.', 'error');
            [nombre, whatsapp, email].find(el => !el.value.trim())?.focus();
            return;
        }
    }

    document.getElementById('postulacion-form-paso-1').classList.toggle('hidden', paso !== 1);
    document.getElementById('postulacion-form-paso-2').classList.toggle('hidden', paso !== 2);
    actualizarProgresoPostulacion(paso);

    if (paso === 1) document.getElementById('post-nombre').focus();
    if (paso === 2) document.getElementById('post-negocio').focus();
}

function actualizarProgresoPostulacion(pasoActivo) {
    const activo = 'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black transition-colors bg-yellow-400 text-black shadow-[0_4px_10px_rgba(250,204,21,0.45)]';
    const pendiente = 'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black transition-colors bg-gray-100 text-gray-400';

    document.getElementById('progreso-punto-1').className = pasoActivo >= 1 ? activo : pendiente;
    document.getElementById('progreso-punto-1').textContent = '1';
    document.getElementById('progreso-punto-2').className = pasoActivo >= 2 ? activo : pendiente;
    document.getElementById('progreso-punto-2').textContent = '2';
}

// Al presionar Enter en un input del paso 1, el navegador dispara el submit
// del form usando el botón "Enviar postulación" del paso 2 (aunque esté
// oculto), y eso termina mostrando el error de "campos incompletos" en vez
// de avanzar al paso 2. Interceptamos el Enter para que se comporte como
// "Continuar"/"Enviar" según el paso en el que esté el usuario.
document.getElementById('form-postulacion').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;

    const enPaso1 = !document.getElementById('postulacion-form-paso-1').classList.contains('hidden');
    if (enPaso1) {
        e.preventDefault();
        irAPasoFormulario(2);
    }
    // Si ya está en el paso 2, dejamos que el Enter dispare el submit normal
    // (el botón "Enviar postulación" ya es el submit visible en ese paso).
});

document.getElementById('form-postulacion').addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn = document.getElementById('btn-enviar-postulacion');
    const datos = {
        tipo: document.getElementById('post-tipo').value,
        nombre: document.getElementById('post-nombre').value.trim(),
        nombre_negocio: document.getElementById('post-negocio').value.trim(),
        whatsapp: document.getElementById('post-whatsapp').value.trim(),
        email: document.getElementById('post-email').value.trim(),
        ciudad: document.getElementById('post-ciudad').value.trim(),
        categoria: document.getElementById('post-categoria').value.trim(),
        instagram: document.getElementById('post-instagram').value.trim(),
        mensaje: document.getElementById('post-mensaje').value.trim(),
    };

    // Todos los campos son obligatorios excepto instagram (es opcional):
    // además del required nativo del HTML, lo revalidamos acá por si el
    // formulario se envía por otra vía.
    const camposFaltantes = Object.entries(datos).some(([campo, valor]) => campo !== 'instagram' && !valor);
    if (camposFaltantes) {
        mostrarToast('Completá todos los campos para enviar la postulación.', 'error');
        return;
    }

    if (!document.getElementById('post-terminos').checked) {
        mostrarToast('Tenés que aceptar los términos y condiciones para enviar la postulación.', 'error');
        document.getElementById('post-terminos').focus();
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    const { error } = await supabase.from('postulaciones').insert(datos);

    btn.disabled = false;
    btn.textContent = 'Enviar postulación';

    if (error) {
        console.error('Error al enviar postulación:', error);
        mostrarToast('No se pudo enviar la postulación. Probá de nuevo.', 'error');
        return;
    }

    document.getElementById('form-postulacion').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.add('hidden');
    document.getElementById('postulacion-progreso').classList.remove('flex');
    document.getElementById('postulacion-paso-exito').classList.remove('hidden');
});
