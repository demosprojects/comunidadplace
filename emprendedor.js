// ============================================================
// PÁGINA DE PERFIL DE EMPRENDEDOR (emprendedor.html?id=...)
// ============================================================

let productos = [];           
let visitorId = null;
let emprendedorActual = null;

let productoModalActual = null;
let variantesModalActual = [];
let seleccionVariantes = {};
let cantidadModalActual = 1;
let mediosPagoModalActual = []; // medios de pago del producto/tienda abiertos en el modal actual

const CARRITO_STORAGE_KEY = 'cp_carrito_v1';
let carrito = { emprendedorId: null, emprendedorNombre: '', emprendedorWhatsapp: '', items: [] };
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

document.addEventListener('DOMContentLoaded', async () => {
    visitorId = obtenerVisitorId();
    cargarCarritoDesdeStorage();

    const params = new URLSearchParams(window.location.search);
    const emprendedorId = params.get('id');

    if (!emprendedorId) {
        mostrarError();
        return;
    }

    await cargarEmprendedor(emprendedorId);
});

// ============================================================
// CARGA DE DATOS
// ============================================================
async function cargarEmprendedor(id) {
    const { data: emprendedor, error } = await supabase
        .from('emprendedores')
        .select('*')
        .eq('id', id)
        .eq('activo', true)
        .single();

    if (error || !emprendedor) {
        console.error(error);
        mostrarError();
        return;
    }

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
}

// ============================================================
// TIEMPO REAL: si el emprendedor sube/edita productos o su perfil
// desde otra pestaña/dispositivo, esta página se actualiza sola
// ============================================================
function iniciarRealtimeEmprendedor(id) {
    const refrescarProductos = debounce(async () => {
        await cargarProductosDelEmprendedor(id);
        aplicarBusqueda();
        // Si un producto de esta tienda que alguien tenía en el carrito
        // se desactivó, lo marcamos como no disponible (no se saca solo).
        sincronizarDisponibilidadCarrito();
    }, 350);

    const refrescarPerfil = debounce(async () => {
        const { data, error } = await supabase.from('emprendedores').select('*').eq('id', id).eq('activo', true).single();
        if (error || !data) { mostrarError(); return; }
        emprendedorActual = data;
        renderPerfil(data);
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

    suscribirTabla('productos', refrescarProductos, `emprendedor_id=eq.${id}`);
    suscribirTabla('emprendedores', refrescarPerfil, `id=eq.${id}`);
    suscribirTabla('variantes', refrescarVariantesModal);
}

async function cargarProductosDelEmprendedor(emprendedorId) {
    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, bio, medios_pago)')
        .eq('activo', true)
        .eq('emprendedor_id', emprendedorId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error(error);
        document.getElementById('contenedor-productos').innerHTML =
            `<p class="col-span-full text-center py-10 text-red-400 italic">No se pudieron cargar los productos. Revisá la conexión con Supabase.</p>`;
        return;
    }
    productos = data;
}

function mostrarError() {
    document.getElementById('perfil-cargando').classList.add('hidden');
    document.getElementById('perfil-error').classList.remove('hidden');
}

// ============================================================
// RENDER DEL PERFIL (Optimizado para el nuevo diseño)
// ============================================================
function renderPerfil(e) {
    document.title = `${e.nombre_tienda || 'Emprendedor'} | Comunidad Place`;

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
            linkMapa.classList.add('inline');
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
            <span class="inline-flex items-center gap-1 bg-white border border-gray-200/80 px-2.5 py-1 rounded-full text-[11px] font-semibold text-gray-700">
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

    mostrarProductos(filtrados);
}

// ============================================================
// RENDER DE CARDS
// ============================================================
function mostrarProductos(lista) {
    const contenedor = document.getElementById('contenedor-productos');
    contenedor.innerHTML = "";

    if (lista.length === 0) {
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
                    Explorar otras tiendas
                    <span>→</span>
                </a>
            </div>`;
        return;
    }

    contenedor.innerHTML = lista.map(p => {
        const esNuevo = p.created_at ? (Date.now() - new Date(p.created_at).getTime()) < (7 * 24 * 60 * 60 * 1000) : false;
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
    document.getElementById('modal-desc').innerText = p.descripcion || '';

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
function sincronizarDisponibilidadCarrito(mostrarAviso = true) {
    if (carrito.items.length === 0) return [];
    if (!emprendedorActual || carrito.emprendedorId !== emprendedorActual.id) return [];

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
    // volvemos a validar contra el catálogo activo de este emprendedor.
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

    let msg = `Hola ${carrito.emprendedorNombre}! Quiero hacer este pedido desde ComunidadPlace:\n\n`;
    carrito.items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.nombre}`;
        if (i.variantesTexto) msg += ` (${i.variantesTexto})`;
        msg += ` x${i.cantidad} - ${formatoPrecio(i.precioUnitario * i.cantidad)}\n`;
    });
    msg += `\nTotal: ${formatoPrecio(calcularTotalCarrito())}`;

    window.open(`https://wa.me/${carrito.emprendedorWhatsapp}?text=${encodeURIComponent(msg)}`, '_blank');
}
