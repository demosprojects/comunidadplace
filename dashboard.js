let perfilActual = null;      // fila de usuarios (id, usuario, rol)
let emprendedorActual = null; // fila de emprendedores
let categorias = [];
let productoEditandoId = null; // null = creando, uuid = editando
let variantesEnEdicion = [];   // [{id?, nombre, valor, precio_adicional, stock, _borrar?}]
let mediosPagoPerfilSeleccion = [];   // ids seleccionados en "Mi Perfil"
let mediosPagoProductoSeleccion = []; // ids seleccionados en el modal de producto
let productosCache = [];      // último listado de productos traído de Supabase

const grid = document.getElementById('grid-productos');
const contadorProductos = document.getElementById('contador-productos');
const modal = document.getElementById('modal-form');
const form = document.getElementById('form-producto');
const selectCategoria = document.getElementById('categoria');
const listaVariantes = document.getElementById('lista-variantes');

// ============================================================
// INICIALIZACIÓN
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    perfilActual = await requerirSesion('emprendedor');
    if (!perfilActual) return; // requerirSesion ya redirige si no corresponde

    document.getElementById('usuario-sidebar').textContent = '@' + perfilActual.usuario;
    document.getElementById('nombre-tienda-sidebar').textContent = perfilActual.usuario;
    document.getElementById('avatar-sidebar-letra').textContent = perfilActual.usuario.charAt(0).toUpperCase();
    await cargarPerfilEmprendedor();
    await cargarCategorias();
    await renderProductos(true);

    iniciarRealtimeDashboard();
});

// ============================================================
// TIEMPO REAL: si se agrega/edita/borra un producto propio (o
// cambia el listado de categorías) desde otra pestaña, se refleja solo
// ============================================================
function iniciarRealtimeDashboard() {
    const refrescarProductos = debounce(renderProductos, 350);

    const refrescarCategorias = debounce(async () => {
        const seleccionActual = selectCategoria.value;
        await cargarCategorias();
        if (seleccionActual) selectCategoria.value = seleccionActual;
    }, 350);

    suscribirTabla('productos', refrescarProductos, `emprendedor_id=eq.${perfilActual.id}`);
    suscribirTabla('categorias', refrescarCategorias);
}

async function cargarCategorias() {
    const { data, error } = await supabase.from('categorias').select('*').order('nombre');
    if (error) { console.error(error); return; }
    categorias = data;
    selectCategoria.innerHTML = categorias.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
}

// ============================================================
// NAVEGACIÓN ENTRE SECCIONES
// ============================================================
// Clases base compartidas por ambos botones del sidebar (layout, tamaño, tipografía).
// Se mantienen siempre iguales; lo único que cambia entre activo/inactivo son los
// colores/fondo/sombra, para no romper el alto ni la alineación del botón.
const NAV_BASE = "w-full text-left px-4 py-3 rounded-xl transition-all flex items-center gap-3 group";
const NAV_ACTIVO = `${NAV_BASE} bg-yellow-400 text-black font-bold shadow-md shadow-yellow-400/10`;
const NAV_INACTIVO = `${NAV_BASE} text-slate-400 hover:text-white hover:bg-white/5`;

function mostrarSeccion(seccionId) {
    const secProductos = document.getElementById('section-productos');
    const secPerfil = document.getElementById('section-perfil');
    const navProductos = document.getElementById('nav-productos');
    const navPerfil = document.getElementById('nav-perfil');

    if (seccionId === 'productos') {
        secProductos.classList.remove('hidden');
        secPerfil.classList.add('hidden');
        navProductos.className = NAV_ACTIVO;
        navPerfil.className = NAV_INACTIVO;
    } else {
        secProductos.classList.add('hidden');
        secPerfil.classList.remove('hidden');
        navPerfil.className = NAV_ACTIVO;
        navProductos.className = NAV_INACTIVO;
    }
}

// ============================================================
// GRID DE PRODUCTOS (CARDS)
// ============================================================
// `mostrarSpinner` sólo se usa en la carga inicial de la página: en los
// refrescos posteriores (realtime, guardar, eliminar) no queremos tapar
// la grilla con el spinner de nuevo, porque da sensación de que la
// página se recarga. En esos casos la grilla se actualiza directo cuando
// llega la respuesta, sin pantalla intermedia.
async function renderProductos(mostrarSpinner = false) {
    if (mostrarSpinner) {
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center gap-3 py-24 text-slate-400 font-semibold">
                <svg class="w-6 h-6 animate-spin text-slate-300" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <span>Cargando productos...</span>
            </div>`;
    }

    const { data, error } = await supabase
        .from('productos')
        .select('*, categorias(nombre)')
        .eq('emprendedor_id', perfilActual.id)
        .order('created_at', { ascending: false });

    if (error) {
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center gap-2 py-24 text-red-400 font-semibold">
                <span>Error cargando productos.</span>
            </div>`;
        contadorProductos.textContent = '';
        console.error(error);
        return;
    }

    productosCache = data;
    pintarGridProductos();
}

// Repinta la grilla a partir de `productosCache`, sin volver a consultar
// Supabase. La usan renderProductos() (después de traer datos frescos) y
// toggleActivoProducto() (para reflejar el cambio al instante).
function pintarGridProductos() {
    const productos = productosCache;
    const btnHeader = document.getElementById('btn-nuevo-producto-header');

    if (productos.length === 0) {
        if (btnHeader) btnHeader.classList.add('hidden');
        grid.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center gap-3 py-24 text-center">
                <div class="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center text-2xl">🛍️</div>
                <p class="text-slate-500 font-bold">Todavía no subiste productos.</p>
                <p class="text-slate-400 text-sm">Empezá creando tu primer producto para mostrarlo en Comunidad Place y en tu perfil.</p>
                <button onclick="abrirFormulario()" class="mt-2 inline-flex items-center gap-2 bg-obsidian text-white px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider hover:bg-yellow-400 hover:text-black transition-all">
                    + Nuevo Producto
                </button>
            </div>`;
        contadorProductos.textContent = '';
        return;
    }

    if (btnHeader) btnHeader.classList.remove('hidden');

    contadorProductos.textContent = `${productos.length} producto${productos.length === 1 ? '' : 's'} · ${productos.filter(p => p.activo).length} visible${productos.filter(p => p.activo).length === 1 ? '' : 's'}`;

    grid.innerHTML = productos.map(p => `
        <div class="group bg-white rounded-3xl border border-slate-200/80 shadow-sm hover:shadow-xl hover:shadow-slate-900/5 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden flex flex-col">
            <div class="relative aspect-square bg-slate-100 overflow-hidden">
                <img src="${p.imagen_url || ''}" alt="${escapeHtml(p.nombre)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                <span class="absolute top-3 left-3 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full backdrop-blur-md ${p.activo ? 'bg-emerald-500/90 text-white' : 'bg-slate-900/70 text-white'}">
                    ${p.activo ? 'Visible' : 'Oculto'}
                </span>
            </div>
            <div class="p-4 flex flex-col gap-1.5 flex-1">
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">${p.categorias ? escapeHtml(p.categorias.nombre) : 'Sin categoría'}</span>
                <h3 class="font-extrabold text-slate-900 leading-snug line-clamp-2">${escapeHtml(p.nombre)}</h3>
                <div class="mt-auto pt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span class="font-black text-lg text-slate-900">${formatoPrecio(p.precio)}</span>
                    <div class="flex items-center gap-1.5 flex-shrink-0 justify-end">
                        <button onclick="toggleActivoProducto('${p.id}', ${p.activo})" title="${p.activo ? 'Ocultar' : 'Mostrar'}" class="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 ${p.activo ? 'hover:bg-slate-700 hover:text-white' : 'hover:bg-emerald-500 hover:text-white'} flex items-center justify-center transition-colors">
                            ${p.activo
                                ? `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`
                                : `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.774 3.162 10.066 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/></svg>`}
                        </button>
                        <button onclick="editarProducto('${p.id}')" title="Editar" class="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 hover:bg-yellow-400 hover:text-black flex items-center justify-center transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                        </button>
                        <button onclick="eliminarProducto('${p.id}')" title="Eliminar" class="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 hover:bg-red-500 hover:text-white flex items-center justify-center transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// ============================================================
// MEDIOS DE PAGO
// ============================================================
function renderMediosPagoPerfil() {
    const cont = document.getElementById('medios-pago-perfil');
    cont.innerHTML = MEDIOS_PAGO.map(m => `
        <button type="button" onclick="toggleMedioPagoPerfil('${m.id}')"
            class="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border-2 text-xs font-bold transition-all ${mediosPagoPerfilSeleccion.includes(m.id) ? 'bg-obsidian text-white border-obsidian' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}">
            <span>${m.icon}</span><span>${m.label}</span>
        </button>
    `).join('');
}

function toggleMedioPagoPerfil(id) {
    mediosPagoPerfilSeleccion = mediosPagoPerfilSeleccion.includes(id)
        ? mediosPagoPerfilSeleccion.filter(x => x !== id)
        : [...mediosPagoPerfilSeleccion, id];
    renderMediosPagoPerfil();
}

function renderMediosPagoProducto() {
    const cont = document.getElementById('medios-pago-producto');
    const disponibles = MEDIOS_PAGO.filter(m => (emprendedorActual?.medios_pago || []).includes(m.id));

    if (disponibles.length === 0) {
        cont.innerHTML = `<p class="text-xs text-slate-400 italic">Todavía no configuraste medios de pago en <button type="button" onclick="mostrarSeccion('perfil'); cerrarFormulario();" class="underline font-bold not-italic">Mi Perfil</button>.</p>`;
        return;
    }

    cont.innerHTML = disponibles.map(m => `
        <button type="button" onclick="toggleMedioPagoProducto('${m.id}')"
            class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border-2 text-xs font-bold transition-all ${mediosPagoProductoSeleccion.includes(m.id) ? 'bg-obsidian text-white border-obsidian' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}">
            <span>${m.icon}</span><span>${m.label}</span>
        </button>
    `).join('');
}

function toggleMedioPagoProducto(id) {
    mediosPagoProductoSeleccion = mediosPagoProductoSeleccion.includes(id)
        ? mediosPagoProductoSeleccion.filter(x => x !== id)
        : [...mediosPagoProductoSeleccion, id];
    renderMediosPagoProducto();
}

// ============================================================
// MODAL: ABRIR / CERRAR
// ============================================================
function abrirFormulario() {
    productoEditandoId = null;
    variantesEnEdicion = [];
    mediosPagoProductoSeleccion = [];
    document.getElementById('titulo-modal').textContent = 'Subir Producto';
    form.reset();
    document.getElementById('imagen').value = '';
    document.getElementById('activo').checked = true;
    actualizarPreviewImagenProducto('');
    renderVariantes();
    renderMediosPagoProducto();
    modal.classList.remove('hidden');
}

function cerrarFormulario() {
    modal.classList.add('hidden');
    form.reset();
    document.getElementById('imagen').value = '';
    productoEditandoId = null;
    variantesEnEdicion = [];
    mediosPagoProductoSeleccion = [];
    actualizarPreviewImagenProducto('');
}

// ============================================================
// SUBIDA DE IMAGEN — PRODUCTO (Supabase Storage)
// ============================================================
async function manejarSeleccionImagenProducto(event) {
    const file = event.target.files[0];
    if (!file) return;

    const errorValidacion = validarImagenSeleccionada(file);
    if (errorValidacion) {
        alert(errorValidacion);
        event.target.value = '';
        return;
    }

    const urlAnterior = document.getElementById('imagen').value;
    mostrarSpinnerImagen('imagen-producto', true);
    try {
        const url = await subirImagenProductoSupabase(file, perfilActual.id);
        document.getElementById('imagen').value = url;
        actualizarPreviewImagenProducto(url);
        // Si estábamos reemplazando una foto subida por este mismo sistema, borramos la vieja
        if (urlAnterior) borrarImagenProductoSupabase(urlAnterior);
    } catch (err) {
        console.error(err);
        alert('No se pudo subir la imagen. Probá de nuevo.');
    } finally {
        mostrarSpinnerImagen('imagen-producto', false);
        event.target.value = '';
    }
}

function mostrarSpinnerImagen(prefijo, mostrar) {
    const spinner = document.getElementById(`${prefijo}-spinner`);
    if (spinner) spinner.classList.toggle('hidden', !mostrar);
}

async function editarProducto(id) {
    const { data: p, error } = await supabase.from('productos').select('*').eq('id', id).single();
    if (error) { alert('No se pudo cargar el producto.'); return; }

    const { data: vs } = await supabase.from('variantes').select('*').eq('producto_id', id);

    productoEditandoId = id;
    variantesEnEdicion = (vs || []).map(v => ({ ...v }));
    mediosPagoProductoSeleccion = p.medios_pago || [];

    document.getElementById('titulo-modal').textContent = 'Editar Producto';
    document.getElementById('nombre').value = p.nombre;
    document.getElementById('precio').value = p.precio;
    document.getElementById('categoria').value = p.categoria_id;
    document.getElementById('imagen').value = p.imagen_url || '';
    document.getElementById('descripcion').value = p.descripcion || '';
    document.getElementById('activo').checked = p.activo;
    actualizarPreviewImagenProducto(p.imagen_url);

    renderVariantes();
    renderMediosPagoProducto();
    modal.classList.remove('hidden');
}

// Muestra la preview de la imagen del producto (o el placeholder si está vacía/URL inválida)
function actualizarPreviewImagenProducto(url) {
    const img = document.getElementById('imagen-producto-preview');
    const placeholder = document.getElementById('imagen-producto-preview-placeholder');
    const valor = (url || '').trim();

    if (!valor) {
        img.classList.add('hidden');
        img.src = '';
        placeholder.classList.remove('hidden');
        return;
    }

    img.onerror = () => {
        img.classList.add('hidden');
        placeholder.classList.remove('hidden');
    };
    img.onload = () => {
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
    };
    img.src = valor;
}

// ============================================================
// VARIANTES (edición en memoria, se guardan al submit)
// ============================================================
function agregarFilaVariante() {
    variantesEnEdicion.push({ nombre: '', valor: '', precio_adicional: 0, stock: null });
    renderVariantes();
}

function quitarFilaVariante(idx) {
    variantesEnEdicion.splice(idx, 1);
    renderVariantes();
}

function actualizarCampoVariante(idx, campo, valor) {
    variantesEnEdicion[idx][campo] = valor;
}

function renderVariantes() {
    if (variantesEnEdicion.length === 0) {
        listaVariantes.innerHTML = `
            <div class="flex items-center justify-between gap-3 border border-dashed border-slate-200 rounded-xl px-3.5 py-3">
                <p class="text-xs text-slate-400">Sin variantes cargadas.</p>
                <button type="button" onclick="agregarFilaVariante()" class="text-xs font-bold text-yellow-700 hover:text-black underline underline-offset-2 whitespace-nowrap">
                    + Agregar la primera
                </button>
            </div>`;
        return;
    }

    const encabezado = `
        <div class="hidden sm:grid grid-cols-12 gap-2 px-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <span class="col-span-3">Nombre</span>
            <span class="col-span-3">Valor</span>
            <span class="col-span-2">+$</span>
            <span class="col-span-3">Stock</span>
        </div>`;

    listaVariantes.innerHTML = encabezado + variantesEnEdicion.map((v, idx) => `
        <div class="grid grid-cols-12 gap-2 items-center bg-slate-50/60 border border-slate-200 rounded-xl p-1.5">
            <input placeholder="Talle" value="${escapeHtml(v.nombre)}"
                oninput="actualizarCampoVariante(${idx}, 'nombre', this.value)"
                class="col-span-3 bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold focus:border-obsidian focus:ring-2 focus:ring-yellow-400/20 outline-none transition-all">
            <input placeholder="M" value="${escapeHtml(v.valor)}"
                oninput="actualizarCampoVariante(${idx}, 'valor', this.value)"
                class="col-span-3 bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold focus:border-obsidian focus:ring-2 focus:ring-yellow-400/20 outline-none transition-all">
            <input type="number" step="0.01" placeholder="0" value="${v.precio_adicional ?? 0}"
                oninput="actualizarCampoVariante(${idx}, 'precio_adicional', this.value)"
                class="col-span-2 bg-white border border-slate-200 rounded-lg px-2 py-2 text-xs font-semibold focus:border-obsidian focus:ring-2 focus:ring-yellow-400/20 outline-none transition-all">
            <input type="number" placeholder="Stock" value="${v.stock ?? ''}"
                oninput="actualizarCampoVariante(${idx}, 'stock', this.value)"
                class="col-span-3 bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-semibold focus:border-obsidian focus:ring-2 focus:ring-yellow-400/20 outline-none transition-all">
            <button type="button" onclick="quitarFilaVariante(${idx})" title="Quitar" class="col-span-1 w-7 h-7 ml-auto rounded-lg flex items-center justify-center text-slate-400 hover:bg-red-500 hover:text-white transition-colors text-sm leading-none">✕</button>
        </div>
    `).join('');
}

// ============================================================
// GUARDAR PRODUCTO (crear o editar) + sus variantes
// ============================================================
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const imagenUrl = document.getElementById('imagen').value.trim();
    if (!imagenUrl) {
        alert('Subí una foto del producto antes de guardar.');
        return;
    }

    const btn = document.getElementById('btn-guardar-producto');
    btn.disabled = true;
    btn.textContent = 'Guardando...';

    const payload = {
        emprendedor_id: perfilActual.id,
        nombre: document.getElementById('nombre').value.trim(),
        precio: parseFloat(document.getElementById('precio').value),
        categoria_id: parseInt(document.getElementById('categoria').value),
        imagen_url: imagenUrl,
        descripcion: document.getElementById('descripcion').value.trim(),
        activo: document.getElementById('activo').checked,
        medios_pago: mediosPagoProductoSeleccion
    };

    try {
        let productoId = productoEditandoId;

        if (productoId) {
            const { error } = await supabase.from('productos').update(payload).eq('id', productoId);
            if (error) throw error;
        } else {
            const { data, error } = await supabase.from('productos').insert(payload).select().single();
            if (error) throw error;
            productoId = data.id;
        }

        // Sincronizamos variantes: actualizamos las que tienen id, insertamos las nuevas
        for (const v of variantesEnEdicion) {
            if (!v.nombre?.trim() || !v.valor?.trim()) continue; // salteamos filas vacías
            const varPayload = {
                producto_id: productoId,
                nombre: v.nombre.trim(),
                valor: v.valor.trim(),
                precio_adicional: v.precio_adicional ? parseFloat(v.precio_adicional) : 0,
                stock: v.stock === '' || v.stock === null ? null : parseInt(v.stock)
            };
            if (v.id) {
                await supabase.from('variantes').update(varPayload).eq('id', v.id);
            } else {
                await supabase.from('variantes').insert(varPayload);
            }
        }

        cerrarFormulario();
        await renderProductos();

    } catch (err) {
        console.error(err);
        alert('Ocurrió un error guardando el producto.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar';
    }
});

async function eliminarProducto(id) {
    if (!confirm('¿Seguro que quieres eliminar este producto? También se eliminarán sus variantes.')) return;
    const { error } = await supabase.from('productos').delete().eq('id', id);
    if (error) { alert('No se pudo eliminar el producto.'); console.error(error); return; }
    await renderProductos();
}

// Activa/desactiva el producto directamente desde la card, sin pasar por
// el formulario de edición ni recargar toda la grilla. Un producto oculto
// no se ve en el catálogo público ni se puede agregar al carrito (ver
// sincronizarDisponibilidadCarrito en main.js / emprendedor.js).
async function toggleActivoProducto(id, activoActual) {
    const nuevoEstado = !activoActual;
    const { error } = await supabase.from('productos').update({ activo: nuevoEstado }).eq('id', id);
    if (error) { alert('No se pudo actualizar la visibilidad del producto.'); console.error(error); return; }

    // Actualizamos el estado en memoria y repintamos al toque, sin volver
    // a pedirle la lista completa a Supabase (eso evita el parpadeo/spinner
    // que daba sensación de que la página se recargaba).
    const item = productosCache.find(p => p.id === id);
    if (item) item.activo = nuevoEstado;
    pintarGridProductos();
}

// ============================================================
// PERFIL DEL EMPRENDEDOR
// ============================================================
async function cargarPerfilEmprendedor() {
    let { data, error } = await supabase
        .from('emprendedores')
        .select('*')
        .eq('id', perfilActual.id)
        .single();

    // Si la cuenta se creó a mano (auth + fila en "usuarios") todavía no existe
    // la fila en "emprendedores" -> la creamos vacía la primera vez que entra.
    if (error && error.code === 'PGRST116') {
        const { data: nuevo, error: errorInsert } = await supabase
            .from('emprendedores')
            .insert({ id: perfilActual.id, nombre_tienda: perfilActual.usuario })
            .select()
            .single();
        if (errorInsert) { console.error(errorInsert); return; }
        data = nuevo;
    } else if (error) {
        console.error(error);
        return;
    }

    emprendedorActual = data;

    document.getElementById('p-nombre').value = data.nombre_tienda || '';
    document.getElementById('p-whatsapp').value = data.whatsapp || '';
    document.getElementById('p-logo').value = data.logo_url || '';
    document.getElementById('p-banner').value = data.banner_url || '';
    document.getElementById('p-bio').value = data.bio || '';
    document.getElementById('p-ubicacion').value = data.ubicacion || '';
    document.getElementById('p-mapa').value = data.mapa_url || '';
    document.getElementById('p-horario').value = data.horario_atencion || '';
    document.getElementById('p-instagram').value = data.instagram || '';
    document.getElementById('p-facebook').value = data.facebook || '';
    document.getElementById('p-tiktok').value = data.tiktok || '';

    mediosPagoPerfilSeleccion = data.medios_pago || [];
    renderMediosPagoPerfil();
    actualizarTarjetaCuentaSidebar(data.nombre_tienda, data.logo_url);
    actualizarPreviewLogo(data.logo_url);
    actualizarPreviewBanner(data.banner_url);
}

// ============================================================
// SUBIDA DE IMAGEN — LOGO Y BANNER (Cloudinary)
// ============================================================
async function manejarSeleccionLogo(event) {
    const file = event.target.files[0];
    if (!file) return;

    const errorValidacion = validarImagenSeleccionada(file);
    if (errorValidacion) {
        alert(errorValidacion);
        event.target.value = '';
        return;
    }

    mostrarSpinnerImagen('p-logo', true);
    try {
        const url = await subirImagenCloudinary(file, 800);
        document.getElementById('p-logo').value = url;
        actualizarPreviewLogo(url);
        actualizarTarjetaCuentaSidebar(document.getElementById('p-nombre').value, url);
    } catch (err) {
        console.error(err);
        alert('No se pudo subir el logo. Probá de nuevo.');
    } finally {
        mostrarSpinnerImagen('p-logo', false);
        event.target.value = '';
    }
}

async function manejarSeleccionBanner(event) {
    const file = event.target.files[0];
    if (!file) return;

    const errorValidacion = validarImagenSeleccionada(file);
    if (errorValidacion) {
        alert(errorValidacion);
        event.target.value = '';
        return;
    }

    mostrarSpinnerImagen('p-banner', true);
    try {
        const url = await subirImagenCloudinary(file, 1600);
        document.getElementById('p-banner').value = url;
        actualizarPreviewBanner(url);
    } catch (err) {
        console.error(err);
        alert('No se pudo subir el banner. Probá de nuevo.');
    } finally {
        mostrarSpinnerImagen('p-banner', false);
        event.target.value = '';
    }
}

// Muestra la preview del banner (o el placeholder si está vacío/URL inválida)
function actualizarPreviewBanner(url) {
    const img = document.getElementById('p-banner-preview');
    const placeholder = document.getElementById('p-banner-preview-placeholder');
    const valor = (url || '').trim();

    if (!valor) {
        img.classList.add('hidden');
        img.src = '';
        placeholder.classList.remove('hidden');
        return;
    }

    img.onerror = () => {
        img.classList.add('hidden');
        placeholder.classList.remove('hidden');
    };
    img.onload = () => {
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
    };
    img.src = valor;
}

// Muestra la preview de la imagen del logo (o el placeholder si está vacío/URL inválida)
function actualizarPreviewLogo(url) {
    const img = document.getElementById('p-logo-preview');
    const placeholder = document.getElementById('p-logo-preview-placeholder');
    const valor = (url || '').trim();

    if (!valor) {
        img.classList.add('hidden');
        img.src = '';
        placeholder.classList.remove('hidden');
        return;
    }

    img.onerror = () => {
        img.classList.add('hidden');
        placeholder.classList.remove('hidden');
    };
    img.onload = () => {
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
    };
    img.src = valor;
}

// Refleja el nombre de la tienda (o el usuario si todavía no lo cargó) y el logo
// en la tarjeta de cuenta del sidebar. Si no hay logo (o la URL falla), muestra
// la letra inicial como respaldo.
function actualizarTarjetaCuentaSidebar(nombreTienda, logoUrl) {
    const nombre = (nombreTienda || '').trim() || perfilActual.usuario;
    document.getElementById('nombre-tienda-sidebar').textContent = nombre;

    const letra = document.getElementById('avatar-sidebar-letra');
    const img = document.getElementById('avatar-sidebar-img');
    letra.textContent = nombre.charAt(0).toUpperCase();

    const url = (logoUrl || '').trim();
    if (!url) {
        img.classList.add('hidden');
        img.src = '';
        letra.classList.remove('hidden');
        return;
    }

    img.onload = () => {
        img.classList.remove('hidden');
        letra.classList.add('hidden');
    };
    img.onerror = () => {
        img.classList.add('hidden');
        letra.classList.remove('hidden');
    };
    img.src = url;
}

async function guardarPerfil() {
    const btn = document.getElementById('btn-guardar-perfil-2');
    const textoOriginal = btn.innerText;
    btn.disabled = true;
    btn.innerText = 'Guardando...';

    const datos = {
        nombre_tienda: document.getElementById('p-nombre').value.trim(),
        whatsapp: document.getElementById('p-whatsapp').value.trim(),
        logo_url: document.getElementById('p-logo').value.trim(),
        banner_url: document.getElementById('p-banner').value.trim(),
        bio: document.getElementById('p-bio').value.trim(),
        ubicacion: document.getElementById('p-ubicacion').value.trim(),
        mapa_url: document.getElementById('p-mapa').value.trim(),
        horario_atencion: document.getElementById('p-horario').value.trim(),
        instagram: document.getElementById('p-instagram').value.trim(),
        facebook: document.getElementById('p-facebook').value.trim(),
        tiktok: document.getElementById('p-tiktok').value.trim(),
        medios_pago: mediosPagoPerfilSeleccion
    };

    const { error } = await supabase.from('emprendedores').update(datos).eq('id', perfilActual.id);

    if (error) {
        console.error(error);
        btn.innerText = 'Error al guardar ✕';
        btn.classList.replace('bg-obsidian', 'bg-red-500');
    } else {
        if (emprendedorActual) emprendedorActual.medios_pago = mediosPagoPerfilSeleccion;
        actualizarTarjetaCuentaSidebar(datos.nombre_tienda, datos.logo_url);
        btn.innerText = '¡PERFIL ACTUALIZADO! ✓';
        btn.classList.replace('bg-obsidian', 'bg-green-500');
    }

    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.classList.remove('bg-green-500', 'bg-red-500');
        btn.classList.add('bg-obsidian');
        btn.disabled = false;
    }, 2000);
}