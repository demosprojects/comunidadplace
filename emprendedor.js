// ============================================================
// PÁGINA DE PERFIL DE EMPRENDEDOR (emprendedor.html?t=mi-tienda)
// Se acepta también ?id=... (formato viejo, por links ya compartidos)
// ============================================================

let productos = [];           
let visitorId = null;
let emprendedorActual = null;
let productosNuevosPendientes = []; // productos que llegaron por INSERT y todavía no se incorporaron a la grilla: [{id}]

let productoModalActual = null;
let variantesModalActual = [];
let seleccionVariantes = {};
let cantidadModalActual = 1;
let mediosPagoModalActual = []; // medios de pago del producto/tienda abiertos en el modal actual

const CARRITO_STORAGE_KEY = 'cp_carrito_v1';
let carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', costoEnvio: 0, envioSeleccionado: true, items: [] };
let itemPendienteConflicto = null;

// ============================================================
// BLOQUEO DE SCROLL DEL FONDO (a prueba de iOS Safari)
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
// SPLASH SCREEN (entrada desde el link directo de un producto)
// Mismo comportamiento que en index.html: el splash ya se mostró al
// instante desde el <script> inline en el <body>; estas funciones lo
// "registran" en el bloqueo de scroll y lo ocultan cuando corresponde.
// ============================================================
function mostrarSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (!splash) return;
    splash.classList.remove('hidden', 'splash-oculto');
    bloquearScrollBody();
}

function ocultarSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (!splash || splash.classList.contains('hidden')) return;
    splash.classList.add('splash-oculto');
    desbloquearScrollBody();
    setTimeout(() => splash.classList.add('hidden'), 500);
}

document.addEventListener('DOMContentLoaded', async () => {
    visitorId = obtenerVisitorId();
    cargarCarritoDesdeStorage();

    const params = new URLSearchParams(window.location.search);
    const slugTienda = params.get('t');
    const emprendedorIdLegacy = params.get('id'); // formato viejo, por links ya compartidos/impresos
    const productoIdDesdeLink = params.get('producto'); // link directo a un producto puntual

    // Si se entra desde el link directo de un producto (?producto=ID), el
    // splash ya se mostró al instante desde el <script> inline en el
    // <body>; acá lo "registramos" en el sistema de bloqueo de scroll y lo
    // dejamos pendiente para abrir el modal más abajo, una vez que cargue
    // el perfil y el catálogo de esta tienda.
    if (productoIdDesdeLink) mostrarSplashScreen();

    if (!slugTienda && !emprendedorIdLegacy) {
        mostrarError();
        return;
    }

    await cargarEmprendedor(slugTienda, emprendedorIdLegacy, productoIdDesdeLink);
});

// ============================================================
// CARGA DE DATOS
// ============================================================
// Resuelve el emprendedor por su "usuario" (slug, link corto) o, si no
// vino, por el "id" viejo (compatibilidad con links ya compartidos).
async function cargarEmprendedor(slug, idLegacy, productoIdDesdeLink) {
    // OJO: para poder filtrar por una columna de la tabla embebida (usuarios.usuario)
    // hace falta el "!inner" -- con un join normal, Postgrest no filtra las filas
    // de "emprendedores" por ese eq, solo filtraría (sin efecto real) el array anidado.
    let query = slug
        ? supabase.from('emprendedores').select('*, usuarios!inner(usuario)').eq('usuarios.usuario', slug)
        : supabase.from('emprendedores').select('*, usuarios(usuario)').eq('id', idLegacy);
    query = query.eq('activo', true);

    const { data: emprendedor, error } = await query.single();

    if (error || !emprendedor) {
        console.error(error);
        mostrarError();
        return;
    }

    const id = emprendedor.id; // a partir de acá seguimos usando el UUID interno para el resto de las consultas
    emprendedorActual = emprendedor;
    renderPerfil(emprendedor);

    await cargarProductosDelEmprendedor(id);
    aplicarBusqueda();
    // Si alguien tenía en el carrito un producto de esta tienda que
    // mientras tanto se desactivó, lo marcamos como no disponible.
    sincronizarDisponibilidadCarrito();

    document.getElementById('perfil-cargando').classList.add('hidden');
    document.getElementById('perfil-contenido').classList.remove('hidden');
    document.getElementById('seccion-productos').classList.remove('hidden');

    document.getElementById('buscador-emprendedor').addEventListener('input', aplicarBusqueda);

    iniciarRealtimeEmprendedor(id);

    // Si se entró desde el link directo de un producto (?producto=ID),
    // le abrimos el modal de detalle apenas termina de cargar el perfil,
    // y recién ahí se oculta el splash (igual que en index.html).
    if (productoIdDesdeLink) {
        const existe = productos.find(p => p.id === productoIdDesdeLink);
        if (existe) {
            await verDetalles(productoIdDesdeLink);
        } else {
            mostrarToast('No pudimos abrir ese producto.', 'error');
        }
        ocultarSplashScreen();
    }
}

// ============================================================
// TIEMPO REAL: si el emprendedor sube/edita productos o su perfil
// desde otra pestaña/dispositivo, esta página se actualiza sola
// ============================================================
function iniciarRealtimeEmprendedor(id) {
    // canalProductos y canalVariantes se dan de baja mientras la tienda
    // está bloqueada y se vuelven a crear si se reactiva, así que van en
    // variables mutables (no const) para poder reasignarlas más abajo.
    let canalProductos, canalVariantes;
    let tiendaBloqueada = false;

    // Red de seguridad: recarga el catálogo entero de esta tienda. Se usa
    // solo cuando no tenemos el detalle del cambio puntual (reconexión /
    // vuelta a la pestaña) o al reactivarse la tienda.
    async function resincronizarProductosCompleto() {
        await cargarProductosDelEmprendedor(id);
        aplicarBusqueda();
        sincronizarDisponibilidadCarrito();
    }
    const resincronizarProductosDebounced = debounce(resincronizarProductosCompleto, 350);

    // ------------------------------------------------------------
    // TIEMPO REAL DE "productos": actualización granular, igual que
    // index.html/main.js. En vez de recargar todo el catálogo de la tienda
    // ante cualquier cambio (lo que hacía parpadear/recomponer toda la
    // grilla), reaccionamos distinto según el tipo de evento:
    //   UPDATE  -> se pisan los datos locales de ESE producto (precio,
    //              precio anterior/oferta, disponibilidad -campo "activo"-,
    //              etc.) y se repinta SOLO esa tarjeta. No se toca el resto
    //              de la grilla ni se llama a Supabase de nuevo.
    //   INSERT  -> el producto NO se agrega solo a la grilla: queda en
    //              espera y se muestra un aviso ("Hay 1 producto nuevo").
    //              El usuario decide si lo quiere ver ahora o lo ignora.
    //   DELETE  -> se saca únicamente esa tarjeta del DOM.
    // ------------------------------------------------------------
    function manejarCambioProducto(payload) {
        if (!payload || !payload.eventType) {
            // El canal se cayó y se reconectó, o el usuario volvió a la
            // pestaña / recuperó conexión. No sabemos qué cambió
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

    // Producto nuevo de ESTA tienda: no se agrega solo a la grilla, se
    // guarda en la lista de pendientes y se arma/actualiza el aviso.
    function manejarProductoInsertado(nuevo) {
        // El canal de "productos" no tiene filtro (ver comentario en la
        // suscripción, más abajo), así que puede llegar un INSERT de
        // OTRA tienda: no nos interesa acá.
        if (String(nuevo.emprendedor_id) !== String(id)) return;
        if (nuevo.activo === false) return; // cargado pero todavía no publicado
        if (productos.some(p => String(p.id) === String(nuevo.id))) return; // ya lo tenemos (evento duplicado)
        if (productosNuevosPendientes.some(p => String(p.id) === String(nuevo.id))) return;

        productosNuevosPendientes.push({ id: nuevo.id });
        mostrarAvisoProductosNuevos();
    }

    // OJO: acá NO tratamos `activo === false` como si el producto se
    // hubiera borrado. `activo` es el campo que el emprendedor usa para
    // marcar "sin stock" (lo pausa) y también "disponible de nuevo" (lo
    // reactiva); en ambos casos la card tiene que PERMANECER en la grilla,
    // solo cambia su estado visual. Sacar la card del todo queda reservado
    // únicamente para el evento DELETE real (ver manejarProductoEliminado).
    async function manejarProductoActualizado(nuevo) {
        if (String(nuevo.emprendedor_id) !== String(id)) {
            // Se movió a otra tienda: si lo teníamos acá, se saca.
            manejarProductoEliminado(nuevo);
            return;
        }

        const idx = productos.findIndex(p => String(p.id) === String(nuevo.id));
        if (idx === -1) {
            // No lo teníamos localmente (p.ej. estaba pausado y se
            // reactivó, o recién se movió a esta tienda): se comporta
            // igual que si fuera un producto nuevo -> aviso, no se
            // inserta solo.
            manejarProductoInsertado(nuevo);
            return;
        }

        const actual = productos[idx];
        if (String(nuevo.categoria_id) !== String(actual.categoria_id)) {
            // Cambió de categoría: pedimos el producto completo de nuevo
            // para tener el nombre de categoría actualizado (acá no
            // mantenemos un caché de categorías como en index.html).
            const { data, error } = await supabase
                .from('productos')
                .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, bio, medios_pago, costo_envio)')
                .eq('id', nuevo.id)
                .single();
            if (!error && data) {
                productos[idx] = normalizarProducto(data);
                actualizarTarjetaProducto(productos[idx]);
                sincronizarDisponibilidadCarrito(false);
                return;
            }
        }

        normalizarProducto(nuevo);
        productos[idx] = { ...actual, ...nuevo, categorias: actual.categorias, emprendedores: actual.emprendedores };
        actualizarTarjetaProducto(productos[idx]);
        // No se recarga la grilla ni se mueve al usuario: sincronizamos el
        // carrito en silencio por si esto afecta algún ítem que tenga cargado.
        sincronizarDisponibilidadCarrito(false);
    }

    function manejarProductoEliminado(viejo) {
        const idProd = viejo && viejo.id;
        if (!idProd) return;

        const habiaEnLocal = productos.some(p => String(p.id) === String(idProd));
        productos = productos.filter(p => String(p.id) !== String(idProd));

        const estabaPendiente = productosNuevosPendientes.some(p => String(p.id) === String(idProd));
        if (estabaPendiente) {
            productosNuevosPendientes = productosNuevosPendientes.filter(p => String(p.id) !== String(idProd));
            mostrarAvisoProductosNuevos();
        }

        if (!habiaEnLocal) return;

        const card = document.querySelector(`[data-producto-id="${idProd}"]`);
        if (card) card.remove();

        // Si esa era la última card visible, mostramos el estado correspondiente.
        const contenedor = document.getElementById('contenedor-productos');
        if (contenedor && contenedor.children.length === 0) aplicarBusqueda();

        sincronizarDisponibilidadCarrito(false);

        if (productoModalActual && String(productoModalActual.id) === String(idProd)) {
            cerrarModal();
            mostrarToast('Este producto ya no está disponible.', 'error');
        }
    }

    // Vuelve a pintar SOLO la tarjeta de este producto (si está visible con
    // la búsqueda actual), sin tocar ninguna otra card ni la posición de scroll.
    function actualizarTarjetaProducto(p) {
        const card = document.querySelector(`[data-producto-id="${p.id}"]`);
        if (!card) return; // no está en pantalla ahora mismo (no pasa la búsqueda activa)
        const wrapper = document.createElement('div');
        wrapper.innerHTML = crearCardHtmlProducto(p);
        const nuevoEl = wrapper.firstElementChild;
        card.replaceWith(nuevoEl);
    }

    const refrescarPerfil = debounce(async () => {
        const { data, error } = await supabase.from('emprendedores').select('*').eq('id', id).eq('activo', true).single();
        if (error || !data) {
            if (!tiendaBloqueada) {
                tiendaBloqueada = true;
                mostrarError();
                // La tienda se bloqueó: dejamos de escuchar productos y
                // variantes (no tiene sentido seguir gastando conexiones
                // en una página que quedó mostrando el cartel de error),
                // pero OJO: seguimos suscriptos al canal de "emprendedores"
                // (canalEmprendedor, más abajo) para enterarnos apenas la
                // vuelvan a activar y poder restaurar la página sola.
                [canalProductos, canalVariantes].forEach(c => c && supabase.removeChannel(c));
                canalProductos = null;
                canalVariantes = null;
            }
            return;
        }

        emprendedorActual = data;
        renderPerfil(data);

        if (tiendaBloqueada) {
            // Se estaba mostrando el cartel de error y la tienda se
            // volvió a activar: restauramos la página sin que el
            // visitante tenga que refrescar manualmente.
            tiendaBloqueada = false;
            document.getElementById('perfil-error').classList.add('hidden');
            document.getElementById('perfil-contenido').classList.remove('hidden');
            document.getElementById('seccion-productos').classList.remove('hidden');

            await resincronizarProductosCompleto();

            // Nos volvemos a suscribir a productos/variantes, que se
            // habían dado de baja al bloquearse la tienda (sin filtro en
            // productos, ver comentario en la suscripción inicial más abajo).
            canalProductos = suscribirTabla('productos', manejarCambioProducto);
            canalVariantes = suscribirTabla('variantes', refrescarVariantesModal);
        }
    }, 350);

    // Si se edita una variante mientras alguien tiene el modal de ese
    // producto abierto (stock, precio adicional, etc), se actualiza sola.
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

    // OJO: sin filtro (a diferencia del canal de "emprendedores" de abajo).
    // Supabase Realtime, en un DELETE, solo puede aplicar un filtro por una
    // columna que no sea la primary key si la tabla tiene REPLICA IDENTITY
    // FULL; "productos" no la tiene, así que un filtro acá por
    // emprendedor_id hacía que los DELETE nunca matchearan y el evento se
    // perdía (el producto borrado seguía viéndose hasta recargar la
    // página). Escuchamos todos los cambios de la tabla, igual que hace
    // index.html, y ya filtramos por esta tienda dentro de cada handler
    // (manejarProductoInsertado/Actualizado/Eliminado, arriba).
    canalProductos = suscribirTabla('productos', manejarCambioProducto);
    const canalEmprendedor = suscribirTabla('emprendedores', refrescarPerfil, `id=eq.${id}`);
    canalVariantes = suscribirTabla('variantes', refrescarVariantesModal);
}

// OJO: NO filtramos por productos.activo acá (igual que index.html/main.js).
// `activo` es el campo que el emprendedor usa tanto para "publicado" como
// para "sin stock" (lo pausa cuando se queda sin stock, lo reactiva cuando
// repone). Si lo filtráramos acá, un producto sin stock desaparecería del
// todo de la grilla en vez de quedar visible marcado "Sin stock" (ver
// crearCardHtmlProducto). La única forma de que una card se saque de
// verdad es que la fila se BORRE (evento DELETE de Realtime, ver
// manejarProductoEliminado).
async function cargarProductosDelEmprendedor(emprendedorId) {
    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, bio, medios_pago, costo_envio)')
        .eq('emprendedores.activo', true)
        .eq('emprendedor_id', emprendedorId)
        .order('destacado', { ascending: false })
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        document.getElementById('contenedor-productos').innerHTML =
            `<p class="col-span-full text-center py-10 text-red-400 italic">No se pudieron cargar los productos. Revisá la conexión con Supabase.</p>`;
        return;
    }
    productos = data.map(normalizarProducto);
    precargarImagenesProductos();
}

// Dispara la descarga de todas las fotos de producto en segundo plano, sin
// esperar a que terminen, para que ya estén en caché cuando el usuario
// busque o abra un producto.
function precargarImagenesProductos() {
    productos.forEach(p => {
        if (!p.imagen_url) return;
        const img = new Image();
        img.src = p.imagen_url;
    });
}

// Normaliza los campos numéricos de un producto apenas llega, sea por REST
// (viene como string, ej "1500.00") o por Realtime (llega como number
// nativo), para que el diff de hashes no se rompa por el tipo de dato.
function normalizarProducto(p) {
    if (!p) return p;
    p.precio = p.precio === null || p.precio === undefined ? p.precio : Number(p.precio);
    p.precio_anterior = p.precio_anterior === null || p.precio_anterior === undefined ? p.precio_anterior : Number(p.precio_anterior);
    return p;
}

function mostrarError() {
    // Si el splash seguía tapando la pantalla (p.ej. vino con ?producto=
    // pero la tienda ya no existe o se bloqueó), lo sacamos para que el
    // cartel de error de abajo sea visible en vez de quedar oculto detrás.
    ocultarSplashScreen();

    // Oculta TODO lo demás, no solo el spinner de carga -- si esto se
    // dispara por Realtime (la tienda se bloqueó mientras alguien ya
    // tenía la página abierta con el perfil y los productos pintados),
    // hay que tapar eso también o queda el cartel de error arriba y el
    // perfil visible abajo, como si nada.
    // El banner (perfil-banner-wrap) vive FUERA de perfil-contenido en el
    // HTML, así que hay que taparlo aparte o queda de fondo detrás del cartel.
    document.getElementById('perfil-cargando').classList.add('hidden');
    document.getElementById('perfil-contenido').classList.add('hidden');
    document.getElementById('seccion-productos').classList.add('hidden');
    document.getElementById('perfil-banner-wrap').classList.add('hidden');
    document.getElementById('perfil-error').classList.remove('hidden');
}

// ============================================================
// RENDER DEL PERFIL (Optimizado para el nuevo diseño)
// ============================================================
function renderPerfil(e) {
    document.title = `${e.nombre_tienda || 'Emprendedor'} | Comunidad Place`;

    // Barra de anuncio temporal
    const anuncioWrap = document.getElementById('perfil-anuncio-wrap');
    const anuncio = (e.anuncio || '').trim();
    if (anuncio) {
        document.getElementById('perfil-anuncio-texto').innerText = anuncio;
        anuncioWrap.classList.remove('hidden');
        anuncioWrap.classList.add('flex');
    } else {
        anuncioWrap.classList.add('hidden');
        anuncioWrap.classList.remove('flex');
    }

    const logo = document.getElementById('perfil-logo');
    const placeholder = document.getElementById('perfil-logo-placeholder');
    if (e.logo_url) {
        logo.src = e.logo_url;
        logo.classList.remove('hidden');
        placeholder.classList.add('hidden');
    } else {
        placeholder.textContent = (e.nombre_tienda || '?').charAt(0).toUpperCase();
        placeholder.classList.remove('hidden');
        logo.classList.add('hidden');
    }

    // Manejo inteligente del Banner de Portada vs Patrón
    const bannerWrap = document.getElementById('perfil-banner-wrap');
    const fondoPatron = document.getElementById('perfil-fondo-patron');
    if (e.banner_url) {
        document.getElementById('perfil-banner').src = e.banner_url;
        bannerWrap.classList.remove('hidden');
        if (fondoPatron) fondoPatron.classList.add('hidden');
    } else {
        bannerWrap.classList.add('hidden');
        if (fondoPatron) fondoPatron.classList.remove('hidden');
    }

    document.getElementById('perfil-nombre').innerText = e.nombre_tienda || '';
    document.getElementById('perfil-bio').innerText = e.bio || 'Este emprendedor todavía no cargó una descripción.';

    // Ubicación + link a mapa
    const ubicacionWrap = document.getElementById('perfil-ubicacion-wrap');
    if (e.ubicacion) {
        document.getElementById('perfil-ubicacion').innerText = e.ubicacion;
        ubicacionWrap.classList.remove('hidden');
        ubicacionWrap.classList.add('inline-flex');
        const linkMapa = document.getElementById('perfil-mapa');
        if (e.mapa_url) {
            linkMapa.href = e.mapa_url;
            linkMapa.classList.remove('hidden');
            linkMapa.classList.add('inline-flex');
        }
    }

    // Horario de atención
    const horarioWrap = document.getElementById('perfil-horario-wrap');
    if (e.horario_atencion) {
        document.getElementById('perfil-horario').innerText = e.horario_atencion;
        horarioWrap.classList.remove('hidden');
        horarioWrap.classList.add('inline-flex');
    }

    // Medios de pago aceptados por la tienda
    const mediosPagoWrap = document.getElementById('perfil-medios-pago-wrap');
    const mediosPago = e.medios_pago || [];
    if (mediosPago.length > 0) {
        document.getElementById('perfil-medios-pago').innerHTML = mediosPago.map(id => `
            <span class="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-gray-700">
                <span>${iconoMedioPago(id)}</span><span>${escapeHtml(nombreMedioPago(id))}</span>
            </span>
        `).join('');
        mediosPagoWrap.classList.remove('hidden');
        mediosPagoWrap.classList.add('flex');
    } else {
        mediosPagoWrap.classList.add('hidden');
        mediosPagoWrap.classList.remove('flex');
    }

    // Redes sociales
    configurarRedSocial('perfil-instagram', e.instagram);
    configurarRedSocial('perfil-facebook', e.facebook);
    configurarRedSocial('perfil-tiktok', e.tiktok);

    const btnWsp = document.getElementById('perfil-whatsapp');
    if (e.whatsapp) {
        const msg = `Hola ${e.nombre_tienda}, te encontré en ComunidadPlace!`;
        btnWsp.href = `https://wa.me/${e.whatsapp}?text=${encodeURIComponent(msg)}`;
        btnWsp.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        btnWsp.href = '#';
        btnWsp.classList.add('opacity-40', 'pointer-events-none');
    }
}

function configurarRedSocial(elementId, url) {
    const link = document.getElementById(elementId);
    if (!url) return;
    link.href = url;
    link.classList.remove('hidden');
    link.classList.add('flex');
}

// ============================================================
// BUSCADOR SIMPLE
// ============================================================
function aplicarBusqueda() {
    const texto = document.getElementById('buscador-emprendedor').value.toLowerCase();
    const filtrados = texto === ''
        ? productos
        : productos.filter(p => p.nombre.toLowerCase().includes(texto));

    const btnClear = document.getElementById('buscador-emprendedor-clear');
    if (btnClear) btnClear.classList.toggle('hidden', texto === '');

    mostrarProductos(filtrados);
}

// Vacía el buscador de esta tienda y vuelve a mostrar todo el catálogo.
function limpiarBusquedaEmprendedor() {
    const input = document.getElementById('buscador-emprendedor');
    if (input) input.value = '';
    aplicarBusqueda();
}

// ============================================================
// AVISO "PRODUCTOS NUEVOS" (igual que index.html, pero acotado a esta
// tienda: no hace falta desglosar por emprendedor)
// ============================================================
function posicionarAvisoProductosNuevos() {
    const el = document.getElementById('aviso-productos-nuevos');
    const header = document.getElementById('site-header');
    if (!el || !header) return;
    el.style.top = (header.offsetHeight + 10) + 'px';
}
window.addEventListener('resize', posicionarAvisoProductosNuevos);

function mostrarAvisoProductosNuevos() {
    const el = document.getElementById('aviso-productos-nuevos');
    if (!el) return;

    if (productosNuevosPendientes.length === 0) {
        el.classList.add('hidden');
        return;
    }

    posicionarAvisoProductosNuevos();

    const cantidad = productosNuevosPendientes.length;
    const textoTitulo = cantidad === 1 ? 'Hay 1 producto nuevo' : `Hay ${cantidad} productos nuevos`;

    // Si solo hay UN producto nuevo, la acción principal lleva directo a
    // ese producto ("Ver producto"); si hay varios, incorpora todos los
    // pendientes a la grilla de una ("Ver novedades").
    const accionPrincipal = cantidad === 1
        ? `<button onclick="verProductoNuevoDesdeAviso('${productosNuevosPendientes[0].id}')" class="bg-black text-white px-4 py-2 rounded-full font-black uppercase text-[11px] tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95 whitespace-nowrap">Ver producto</button>`
        : `<button onclick="verNovedadesProductos()" class="bg-black text-white px-4 py-2 rounded-full font-black uppercase text-[11px] tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95 whitespace-nowrap">Ver novedades</button>`;

    el.innerHTML = `
        <div class="flex items-start gap-2.5 min-w-0">
            <span class="text-base leading-none mt-0.5 flex-shrink-0">✨</span>
            <p class="text-sm font-bold leading-snug">${textoTitulo}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
            ${accionPrincipal}
            <button onclick="cerrarAvisoProductosNuevos()" aria-label="Cerrar aviso" class="w-8 h-8 rounded-full flex items-center justify-center text-gray-500 hover:text-black hover:bg-yellow-100 transition-colors flex-shrink-0">✕</button>
        </div>`;

    el.classList.remove('hidden');
}

// El usuario cierra el aviso sin interesarle: se descarta la lista de
// pendientes. Esos productos van a aparecer solos la próxima vez que se
// resincronice el catálogo completo (recarga de página, reconexión, etc.).
function cerrarAvisoProductosNuevos() {
    productosNuevosPendientes = [];
    mostrarAvisoProductosNuevos();
}

// Trae de Supabase (con sus joins) los productos pendientes que el usuario
// quiere ver, los agrega a `productos` y repinta la grilla con el diff de
// siempre (mostrarProductos ya se encarga de no tocar las cards que no cambiaron).
async function incorporarProductosNuevosPendientes(ids) {
    if (!ids || ids.length === 0 || !emprendedorActual) return;

    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, bio, medios_pago, costo_envio)')
        .in('id', ids)
        .eq('emprendedor_id', emprendedorActual.id)
        .eq('activo', true)
        .eq('emprendedores.activo', true);

    if (error) {
        console.error('Error incorporando productos nuevos:', error);
        mostrarToast('No se pudieron cargar los productos nuevos.', 'error');
        return;
    }

    data.forEach(p => {
        normalizarProducto(p);
        if (!productos.some(existente => String(existente.id) === String(p.id))) productos.push(p);
    });
    precargarImagenesProductos();
    aplicarBusqueda();
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
// pendientes a la grilla de una y lleva al usuario arriba de la vitrina.
async function verNovedadesProductos() {
    const ids = productosNuevosPendientes.map(p => p.id);
    await incorporarProductosNuevosPendientes(ids);
    quitarDePendientesNuevos(ids);
    const destino = document.getElementById('contenedor-productos');
    if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// RENDER DE CARDS
// ============================================================
function crearCardHtmlProducto(p) {
    const descuentoPct = calcularDescuentoPorcentaje(p.precio_anterior, p.precio);
    // `activo === false` = el emprendedor lo pausó por falta de stock. La
    // card sigue en la grilla, solo se marca "Sin stock" y no se puede
    // comprar (ver agregarAlCarrito).
    const sinStock = p.activo === false;
    // Foto de los datos que afectan el render: si no cambió nada de esto,
    // mostrarProductos() deja el nodo tal cual (sin parpadeo).
    const hash = escapeHtml(JSON.stringify({
        n: p.nombre, pr: p.precio, pa: p.precio_anterior, img: p.imagen_url,
        cat: p.categorias ? p.categorias.nombre : null,
        d: !!p.destacado, nv: esProductoNuevoVigente(p), act: sinStock ? false : true
    }));
    return `
        <div class="group cursor-pointer h-full flex flex-col bg-white rounded-2xl sm:rounded-3xl lg:rounded-2xl border ${p.destacado ? 'border-yellow-400/90 ring-1 ring-yellow-400/50 shadow-lg shadow-yellow-400/10' : 'border-gray-100 shadow-sm'} hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300 overflow-hidden animate-fade-in" data-producto-id="${p.id}" data-hash="${hash}" onclick="verDetalles('${p.id}')">
            <div class="relative aspect-[4/5] lg:aspect-[4/3] overflow-hidden bg-gray-50 flex-shrink-0 flex items-center justify-center">
                <img src="${miniaturaCloudinary(p.imagen_url, 500)}" alt="${escapeHtml(p.nombre)}" class="w-full h-full object-contain p-3 sm:p-5 lg:p-3.5 transition duration-300 ${sinStock ? 'grayscale opacity-50' : ''}" loading="lazy" decoding="async">
                ${sinStock ? `
                <span class="absolute top-1.5 sm:top-3 lg:top-2 left-1.5 sm:left-3 lg:left-2 bg-gray-800 text-white text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest">Sin stock</span>`
                : (esProductoNuevoVigente(p) ? `
                <span class="absolute top-1.5 sm:top-3 lg:top-2 left-1.5 sm:left-3 lg:left-2 bg-yellow-400 text-black text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest">Nuevo</span>` : '')}
                ${p.destacado ? `
                <span class="absolute top-1.5 sm:top-3 lg:top-2 right-1.5 sm:right-3 lg:right-2 flex items-center gap-1 bg-gradient-to-br from-yellow-300 to-yellow-500 text-black text-[7px] sm:text-[9px] font-black pl-1.5 pr-2 sm:pl-2 sm:pr-2.5 py-0.5 sm:py-1 rounded-full shadow-md shadow-yellow-500/40 uppercase tracking-widest">
                    <svg class="w-2.5 h-2.5 sm:w-3 sm:h-3 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.6 5.27 5.82.85-4.21 4.1.99 5.8L12 15.8l-5.2 2.72.99-5.8-4.21-4.1 5.82-.85L12 2.5z"/></svg>
                    Destacado
                </span>` : ''}
            </div>
            <div class="p-2.5 sm:p-5 lg:p-3.5 flex flex-col flex-1 ${sinStock ? 'opacity-60' : ''}">
                <h3 class="font-black text-xs sm:text-lg lg:text-sm leading-snug group-hover:text-yellow-600 transition-colors min-h-[2.4em] sm:min-h-[2.6em] lg:min-h-[2.4em] line-clamp-2">${escapeHtml(p.nombre)}</h3>
                <span class="text-[8px] sm:text-[10px] font-bold text-gray-400 uppercase tracking-widest truncate mt-0.5 sm:mt-1">${p.categorias ? escapeHtml(p.categorias.nombre) : 'General'}</span>
                <div class="flex items-center justify-between mt-auto pt-2 sm:pt-4 lg:pt-2">
                    <div class="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-wrap">
                        <span class="font-900 text-sm sm:text-xl lg:text-base">${formatoPrecio(p.precio)}</span>
                        ${descuentoPct > 0 ? `
                            <span class="text-[9px] sm:text-xs font-bold text-gray-400 line-through">${formatoPrecio(p.precio_anterior)}</span>
                            <span class="text-[7px] sm:text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-red-600 text-white">-${descuentoPct}% OFF</span>
                        ` : ''}
                    </div>
                    <span class="w-7 h-7 sm:w-10 sm:h-10 lg:w-8 lg:h-8 rounded-full bg-black text-white flex items-center justify-center text-xs sm:text-sm group-hover:bg-yellow-400 group-hover:text-black transition-all active:scale-90 flex-shrink-0">→</span>
                </div>
            </div>
        </div>
    `;
}

// Igual que en main.js: diffea contra lo que ya está en el DOM en vez de
// tirar todo y reconstruir, para que no parpadee la grilla cuando llega un
// cambio por tiempo real (propio, de otra pestaña, o de otro colaborador
// de la misma tienda).
function mostrarProductos(lista) {
    const contenedor = document.getElementById('contenedor-productos');

    if (lista.length === 0) {
        contenedor.dataset.vacio = '1';

        // Dos casos bien distintos comparten "lista vacía":
        // 1) La tienda todavía no cargó ningún producto (catálogo real vacío).
        // 2) Hay productos, pero la búsqueda no encontró ninguno.
        // Antes se mostraba siempre el mensaje de "catálogo vacío", incluso
        // buscando algo que la tienda sí tiene pero no coincide con nada.
        if (productos.length === 0) {
            const nombreTienda = escapeHtml((emprendedorActual && emprendedorActual.nombre_tienda) || 'Esta tienda');
            contenedor.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center text-center py-16 sm:py-24 px-4 animate-fade-in">
                    <div class="relative mb-6">
                        <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-gradient-to-br from-yellow-300 to-yellow-500 flex items-center justify-center shadow-xl rotate-3">
                            <svg class="w-9 h-9 sm:w-10 sm:h-10 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                            </svg>
                        </div>
                        <span class="absolute -bottom-2 -right-2 w-9 h-9 rounded-full bg-black text-yellow-400 flex items-center justify-center text-base border-4 border-white shadow-lg -rotate-6">⏳</span>
                    </div>
                    <h3 class="text-xl sm:text-2xl font-900 uppercase italic text-zinc-900 leading-tight">Todavía sin productos</h3>
                    <p class="text-gray-500 text-sm sm:text-base max-w-sm mt-2.5 leading-relaxed">
                        ${nombreTienda} está preparando su catálogo. Volvé pronto o mientras tanto descubrí otras tiendas de la comunidad.
                    </p>
                    <a href="index.html#contenedor-productos" class="inline-flex items-center gap-2 mt-7 bg-black text-white px-6 sm:px-7 py-3 sm:py-3.5 rounded-full font-black uppercase text-xs tracking-widest hover:bg-yellow-400 hover:text-black transition-all active:scale-95 shadow-xl">
                        Explorar otros productos
                        <span>→</span>
                    </a>
                </div>`;
        } else {
            contenedor.innerHTML = `
                <div class="col-span-full flex flex-col items-center justify-center text-center py-20">
                    <span class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-5">
                        <svg class="w-7 h-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                            <path stroke-linecap="round" d="M9.3 9.3l3.4 3.4m0-3.4l-3.4 3.4" />
                        </svg>
                    </span>
                    <p class="font-black text-sm uppercase tracking-widest">Sin resultados</p>
                    <p class="text-gray-400 text-xs mt-1.5 max-w-[15rem]">No encontramos productos de esta tienda con esa búsqueda.</p>
                    <button onclick="limpiarBusquedaEmprendedor()" class="mt-6 border-2 border-black px-6 py-2.5 rounded-full font-bold uppercase text-xs tracking-widest hover:bg-black hover:text-white transition-all active:scale-95">
                        Limpiar búsqueda
                    </button>
                </div>`;
        }
        return;
    }

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

        const siguienteEsperado = anchorAnterior ? anchorAnterior.nextSibling : contenedor.firstChild;
        if (siguienteEsperado !== el) {
            contenedor.insertBefore(el, siguienteEsperado);
        }
        anchorAnterior = el;
    });

    existentes.forEach(el => el.remove());
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
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
    document.getElementById('modal-tienda').innerText = p.emprendedores ? p.emprendedores.nombre_tienda : '';
    document.getElementById('modal-desc').innerText = p.descripcion || 'Sin descripción disponible.';

    const modalCategoria = document.getElementById('modal-categoria');
    if (modalCategoria) modalCategoria.innerText = p.categorias ? p.categorias.nombre : 'General';
    const sinStock = p.activo === false;
    const modalBadgeNuevo = document.getElementById('modal-badge-nuevo');
    if (modalBadgeNuevo) modalBadgeNuevo.classList.toggle('hidden', sinStock || !esProductoNuevoVigente(p));
    const modalBadgeSinStock = document.getElementById('modal-badge-sin-stock');
    if (modalBadgeSinStock) modalBadgeSinStock.classList.toggle('hidden', !sinStock);
    const modalBadgeDestacado = document.getElementById('modal-badge-destacado');
    if (modalBadgeDestacado) {
        modalBadgeDestacado.classList.toggle('hidden', !p.destacado);
        modalBadgeDestacado.classList.toggle('flex', !!p.destacado);
    }
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

    _lbReiniciarEstadoZoom();

    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    bloquearScrollBody();

    // Forzamos reflow para que la transición de entrada se dispare
    requestAnimationFrame(() => {
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

    desbloquearScrollBody();
    document.removeEventListener('keydown', _cerrarLightboxImagenConEsc);
    _lbReiniciarEstadoZoom();

    setTimeout(() => {
        lightbox.classList.add('hidden');
        lightbox.classList.remove('flex');
        img.src = '';
    }, 300);
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

function modificarCantidadModal(delta) {
    cantidadModalActual = Math.max(1, cantidadModalActual + delta);
    document.getElementById('modal-cantidad').innerText = cantidadModalActual;
}

// ============================================================
// CARRITO
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
// catálogo activo de ESTE emprendedor. El producto se queda en el carrito
// con un aviso de "no disponible" y el botón de enviar pedido queda
// bloqueado: el usuario tiene que eliminarlo a mano para poder seguir.
// Esta página sólo conoce los productos del emprendedor que se está
// viendo, así que si el carrito es de otro emprendedor no lo tocamos acá
// (se valida en la página que corresponda).
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
    if (!emprendedorActual || carrito.emprendedorId !== emprendedorActual.id) return [];

    // Igual que en index.html: un producto sólo está realmente disponible
    // para comprar si figura en el catálogo Y además tiene activo === true
    // (los sin stock se quedan cargados en memoria para poder pintar su
    // card marcada "Sin stock", pero no se pueden agregar/mantener en el carrito).
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

    // El precio del carrito quedaba "congelado" al valor que tenía cuando se
    // agregó: si el emprendedor editaba el precio del producto después, quien
    // ya lo tenía en el carrito seguía viendo el precio viejo. Acá lo
    // recalculamos para los items cuyo precio depende del precio BASE del
    // producto.
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

    // usaPrecioBase: si NINGUNA variante seleccionada tiene precio propio, el
    // precio del item es directamente el precio del producto -> hay que
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
    if (!emprendedorActual || carrito.emprendedorId !== emprendedorActual.id) return;

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
            // No estaba en memoria (p.ej. estaba pausado y no se había
            // cargado): lo agregamos igual para que la comparación de
            // disponibilidad de abajo lo tenga en cuenta.
            productos.push({ id: row.id, precio: Number(row.precio), activo: row.activo });
        }
    });

    // Si el carrito sigue abierto y esto trajo algún cambio real,
    // sincronizarDisponibilidadCarrito ya se encarga de re-renderizarlo.
    sincronizarDisponibilidadCarrito();
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

// Detecta si estamos en un celular/tablet (vs. PC). En PC no tiene sentido
// abrir wa.me directo porque es difícil que el usuario tenga WhatsApp
// abierto ahí; en ese caso mostramos un QR para escanear con el celular.
function esDispositivoMobile() {
    const uaMobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(navigator.userAgent);
    const pantallaChica = window.matchMedia('(max-width: 767px)').matches;
    return uaMobile || pantallaChica;
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
    document.getElementById('modal-qr-pedido').classList.remove('hidden');
    bloquearScrollBody();

    if (typeof QRCode === 'undefined') {
        console.error('No se pudo cargar qrcode.min.js (revisá que el archivo esté subido junto a emprendedor.html)');
        cont.innerHTML = '<span class="text-[11px] font-bold text-red-500 px-3 leading-snug">No pudimos generar el QR</span>';
        return;
    }
    QRCode.toCanvas(urlWaMe, { width: 260, margin: 1 }, (error, canvas) => {
        if (error) {
            console.error('No se pudo generar el QR del pedido', error);
            cont.innerHTML = '<span class="text-[11px] font-bold text-red-500 px-3 leading-snug">No pudimos generar el QR</span>';
            return;
        }
        cont.innerHTML = '';
        cont.appendChild(canvas);
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
    finalizarPedido();
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
    desbloquearScrollBody();
    _qrPedidoUrlWhatsappWeb = null;
    abrirCarrito();
}

async function enviarPedidoWhatsapp() {
    if (carrito.items.length === 0) return;
    if (!carrito.emprendedorWhatsapp) {
        alert('Este emprendedor todavía no cargó un número de WhatsApp para recibir pedidos.');
        return;
    }

    // 1) Chequeo rápido contra la caché local `productos` de esta tienda
    // (sólo aplica si el carrito es de este mismo emprendedor). Si algo
    // se desactivó recién, se marca como no disponible y se frena el
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

    // Armamos la base del link de vuelta a esta tienda (igual que en index.html,
    // pero acá hay que conservar el slug/id de la tienda con "?t=" o "?id=" para
    // que el link de cada producto abra directo en el perfil correcto).
    const slugTienda = (emprendedorActual && emprendedorActual.usuarios && emprendedorActual.usuarios.usuario)
        || new URLSearchParams(window.location.search).get('t');
    const baseUrl = slugTienda
        ? `${window.location.origin}${window.location.pathname}?t=${encodeURIComponent(slugTienda)}`
        : `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(carrito.emprendedorId || '')}`;

    const quiereEnvioMsg = carrito.envioSeleccionado !== false;

    let msg = `Hola ${carrito.emprendedorNombre}! Quiero hacer este pedido desde ComunidadPlace:\n\n`;
    if (carrito.costoEnvio > 0) {
        msg += `Modalidad de entrega: ${quiereEnvioMsg ? 'Envío a domicilio' : 'Retiro en el local'}\n\n`;
    }
    carrito.items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.nombre}`;
        if (i.variantesTexto) msg += ` (${i.variantesTexto})`;
        msg += ` x${i.cantidad} - ${formatoPrecio(i.precioUnitario * i.cantidad)}\n`;
        if (i.productoId) msg += `   ${baseUrl}&producto=${i.productoId}\n`;
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
