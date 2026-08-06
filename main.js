let productos = [];        // productos ya traídos de Supabase (con joins)
let categoriasDB = [];
let visitorId = null;
let productoModalActual = null;
let variantesModalActual = [];
let seleccionVariantes = {}; // { nombreGrupo: {valor, precio_adicional} }
let cantidadModalActual = 1;

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

    iniciarRealtime();

    document.getElementById('buscador').addEventListener('input', aplicarFiltros);

    document.addEventListener('click', (e) => {
        ['categoria', 'emprendedor', 'orden'].forEach(tipo => {
            if (!e.target.closest(`#btn-filtro-${tipo}`) && !e.target.closest(`#panel-filtro-${tipo}`)) {
                cerrarFiltroPanel(tipo);
            }
        });
    });

    window.addEventListener('resize', () => {
        ['categoria', 'emprendedor', 'orden'].forEach(tipo => {
            const panel = document.getElementById(`panel-filtro-${tipo}`);
            if (panel && !panel.classList.contains('hidden')) posicionarPanelFiltro(panel);
        });
    });
});

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
    }, 350);

    // Nuevo emprendedor, bloqueado/activado, o editó su perfil (nombre/logo)
    // -> refresca la fila de logos, el panel de filtro y las cards (usan esos datos)
    const refrescarEmprendedores = debounce(async () => {
        await cargarEmprendedoresFila();
        await cargarProductos();
        aplicarFiltros();
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
        .select('*, categorias(id, nombre), emprendedores!inner(id, nombre_tienda, whatsapp, activo, logo_url, banner_url, bio, ubicacion, mapa_url, horario_atencion, instagram, facebook, tiktok)')
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
            <div class="group cursor-pointer h-full flex flex-col bg-white rounded-2xl sm:rounded-3xl border border-gray-100 shadow-sm hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300 overflow-hidden animate-fade-in" onclick="verDetalles('${p.id}')">
                <div class="relative aspect-[4/5] overflow-hidden bg-gray-50 flex-shrink-0 flex items-center justify-center">
                    <img src="${p.imagen_url || ''}" alt="${escapeHtml(p.nombre)}" class="w-full h-full object-contain p-3 sm:p-5 transition duration-300">
                    <div class="absolute top-1.5 sm:top-3 left-1.5 sm:left-3 flex gap-1 sm:gap-1.5">
                        ${esNuevo ? `<span class="bg-yellow-400 text-black text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest">Nuevo</span>` : ''}
                        <span class="bg-white/90 backdrop-blur text-black text-[7px] sm:text-[9px] font-black px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-full shadow uppercase tracking-widest truncate max-w-[70px] sm:max-w-none">${p.categorias ? escapeHtml(p.categorias.nombre) : 'General'}</span>
                    </div>
                </div>
                <div class="p-2.5 sm:p-5 flex flex-col flex-1">
                    <button onclick="event.stopPropagation(); abrirPerfilEmprendedor('${p.emprendedores ? p.emprendedores.id : ''}')"
                        class="flex items-center gap-1.5 sm:gap-2 mb-1.5 sm:mb-2 -ml-1 pl-1 pr-2.5 py-0.5 sm:py-1 rounded-full hover:bg-yellow-50 transition-colors group/tienda w-full text-left flex-shrink-0">
                        ${avatarTienda}
                        <span class="text-gray-500 text-[8px] sm:text-[10px] font-bold uppercase tracking-widest group-hover/tienda:text-black truncate flex-1 transition-colors">${escapeHtml(tienda)}</span>
                        <span class="hidden sm:inline text-gray-300 group-hover/tienda:text-yellow-600 group-hover/tienda:translate-x-0.5 transition-all text-xs flex-shrink-0">›</span>
                    </button>
                    <h3 class="font-black text-xs sm:text-lg leading-snug group-hover:text-yellow-600 transition-colors min-h-[2.4em] sm:min-h-[2.6em] line-clamp-2">${escapeHtml(p.nombre)}</h3>
                    <div class="flex items-center justify-between mt-auto pt-2 sm:pt-4">
                        <span class="font-900 text-sm sm:text-xl">${formatoPrecio(p.precio)}</span>
                        <span class="w-7 h-7 sm:w-10 sm:h-10 rounded-full bg-black text-white flex items-center justify-center text-xs sm:text-sm group-hover:bg-yellow-400 group-hover:text-black transition-all active:scale-90 flex-shrink-0">→</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function limpiarFiltros() {
    document.getElementById('buscador').value = '';

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
    document.getElementById('modal-desc').innerText = p.descripcion || '';

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

function cerrarModal() {
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
function abrirPerfilEmprendedor(emprendedorId) {
    if (!emprendedorId) return;

    // Buscamos los datos del emprendedor entre los productos ya cargados
    // (todos vienen con el join a "emprendedores", así que no hace falta pedirlos de nuevo)
    const productoConDatos = productos.find(p => p.emprendedores && p.emprendedores.id === emprendedorId);
    if (!productoConDatos) return;
    const e = productoConDatos.emprendedores;

    // Banner de fondo (opcional)
    const bannerWrap = document.getElementById('perfil-banner-wrap');
    if (e.banner_url) {
        document.getElementById('perfil-banner').src = e.banner_url;
        bannerWrap.classList.remove('hidden');
    } else {
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
    document.getElementById('perfil-cantidad').innerText = `${cantidadProductos} producto${cantidadProductos === 1 ? '' : 's'} en la comunidad`;

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

    const btnVerProductos = document.getElementById('perfil-ver-productos');
    btnVerProductos.onclick = () => {
        window.location.href = `emprendedor.html?id=${encodeURIComponent(emprendedorId)}`;
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
        variantesTexto
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
    if (!item) return;
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
    return carrito.items.reduce((sum, i) => sum + i.precioUnitario * i.cantidad, 0);
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
        subtitulo.innerText = `De ${carrito.emprendedorNombre}`;
        btnWsp.classList.remove('opacity-40', 'pointer-events-none');
        cont.innerHTML = carrito.items.map(i => `
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
            </div>
        `).join('');
    }

    document.getElementById('carrito-total').innerText = formatoPrecio(calcularTotalCarrito());
}

function abrirCarrito() {
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
function enviarPedidoWhatsapp() {
    if (carrito.items.length === 0) return;
    if (!carrito.emprendedorWhatsapp) {
        alert('Este emprendedor todavía no cargó un número de WhatsApp para recibir pedidos.');
        return;
    }

    let msg = `Hola ${carrito.emprendedorNombre}! Quiero hacer este pedido desde ComunidadPlace:\n\n`;
    carrito.items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.nombre}`;
        if (i.variantesTexto) msg += ` (${i.variantesTexto})`;
        msg += ` x${i.cantidad} - ${formatoPrecio(i.precioUnitario * i.cantidad)}\n`;
    });
    msg += `\nTotal: ${formatoPrecio(calcularTotalCarrito())}`;

    window.open(`https://wa.me/${carrito.emprendedorWhatsapp}?text=${encodeURIComponent(msg)}`, '_blank');
}