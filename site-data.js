/* =========================================================
   SITE-DATA.JS
   Escucha en TIEMPO REAL (onSnapshot) los cambios en Firestore
   que se hacen desde el panel admin (admin.html) y actualiza
   la web pública (index.html) sin necesidad de recargar.
   No modifica el comportamiento de app.js, solo llena el DOM
   con datos y después dispara las funciones de app.js que
   necesitan que el contenido ya esté en la página
   (actualizarImagenesGaleria, iniciarCarruselInfinito).
   ========================================================= */

function escaparHtml(texto) {
    const div = document.createElement('div');
    div.textContent = texto ?? "";
    return div.innerHTML;
}

/* ---------- OPTIMIZACIÓN DE IMÁGENES DE LOS LOGOS ----------
   Antes los logos se pedían en su tamaño y peso originales (a veces varios
   MB), aunque en la web se muestran en círculos chiquitos de ~130px. Eso es
   lo que los hacía tardar tanto en conexiones móviles.

   Los emprendedores/comercios cargan el logo de dos formas: subiendo el
   archivo (queda en Cloudinary, res.cloudinary.com) o pegando un link
   externo (por ejemplo de ibb.co). Para el caso de Cloudinary, alcanza con
   insertar los parámetros de tamaño/calidad en la URL. Para un link externo
   no podemos pedirle a ibb.co que nos dé una versión optimizada, pero sí
   podemos usar el modo "fetch" de nuestra propia cuenta de Cloudinary: le
   pasamos la URL externa, Cloudinary la trae, la redimensiona/comprime y
   nos devuelve esa versión ya optimizada (quedando ella cacheada ahí, sin
   tocar el archivo original ni el ibb.co del emprendedor). */
const CLOUDINARY_CLOUD = 'dloroyhev';

function logoOptimizado(url, ladoPx = 200) {
    if (!url || typeof url !== 'string') return url;
    const transformacion = `w_${ladoPx},h_${ladoPx},c_fill,g_auto,q_auto,f_auto`;

    const marcadorUpload = '/upload/';
    const idxUpload = url.indexOf(marcadorUpload);
    if (url.includes('res.cloudinary.com') && idxUpload !== -1) {
        // Ya es un archivo nuestro en Cloudinary: insertamos la transformación.
        return url.slice(0, idxUpload + marcadorUpload.length) + transformacion + '/' + url.slice(idxUpload + marcadorUpload.length);
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
        // Link externo (ibb.co u otro): lo hacemos pasar por Cloudinary en
        // modo "fetch" para que también quede optimizado.
        return `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/image/fetch/${transformacion}/${encodeURIComponent(url)}`;
    }

    return url;
}

/* ---------- LOADER PARA LOGOS (mientras carga el servidor de imágenes) ----------
   Nuestro servidor de imágenes puede tardar en responder, sobre todo en
   conexiones móviles. En vez de dejar el círculo en blanco hasta que la
   imagen esté lista, mostramos un "skeleton" animado (mismo estilo que ya
   usa el resto del sitio) y recién mostramos la imagen real cuando terminó
   de cargar (evento onload).

   Si la versión OPTIMIZADA falla (por ejemplo porque el modo "fetch" de
   Cloudinary no está habilitado para links externos como los de ibb.co),
   reintentamos una sola vez con la URL ORIGINAL sin optimizar, para no
   perder el logo. Solo si esa segunda carga también falla mostramos el
   ícono genérico. */
function imgConLoader(url, alt, imgClass) {
    const urlOriginalEscapada = escaparHtml(url || '');
    const urlOptimizadaEscapada = escaparHtml(logoOptimizado(url));
    const altEscapado = escaparHtml(alt);
    return `
        <div class="skeleton w-full h-full rounded-full flex items-center justify-center">
            <img src="${urlOptimizadaEscapada}" alt="${altEscapado}" class="${imgClass} opacity-0 transition-opacity duration-500"
                 data-original="${urlOriginalEscapada}"
                 onload="this.classList.remove('opacity-0'); this.parentElement.classList.remove('skeleton');"
                 onerror="
                    if (this.dataset.original && this.src !== this.dataset.original) {
                        this.onerror = function() { this.parentElement.classList.remove('skeleton'); this.classList.remove('opacity-0'); this.parentElement.innerHTML='<i class=\\'fas fa-store text-slate-300 text-2xl\\'></i>'; };
                        this.src = this.dataset.original;
                    } else {
                        this.parentElement.classList.remove('skeleton'); this.classList.remove('opacity-0'); this.parentElement.innerHTML='<i class=\\'fas fa-store text-slate-300 text-2xl\\'></i>';
                    }">
        </div>`;
}

/* ---------- MENSAJE DE ERROR / REINTENTO ----------
   Se usa cuando Firestore tarda demasiado o falla (conexión lenta o
   bloqueada, típico en datos móviles). Antes esto dejaba la sección
   completamente en blanco y sin explicación; ahora avisamos y damos
   la opción de reintentar sin tener que buscar cómo refrescar. */
function mensajeErrorCarga(claseAdicional = '') {
    return `<p class="text-slate-400 text-sm italic w-full ${claseAdicional}">
        Esto está tardando más de lo normal para cargar.
        <button onclick="location.reload()" class="underline font-bold text-yellow-600">Reintentar</button>
    </p>`;
}

/* ---------- 1. PRÓXIMOS EVENTOS (una o varias ferias activas) ---------- */
// Antes se mostraba una sola feria "activa" a la vez. Ahora se pueden marcar
// varias como activas (por ejemplo la de este domingo y la siguiente) y acá
// se pintan todas, apiladas, con el mismo diseño. La primera se etiqueta
// "Próxima Edición" y el resto "Siguiente Feria". Se ordenan por fecha de
// creación para que, al ir borrando la que ya pasó, la que sigue pase
// automáticamente a ocupar el primer lugar.
function escucharFeriaActiva() {
    const container = document.getElementById('ferias-container');
    const sinEventos = document.getElementById('feria-sin-eventos');
    if (!container) return;

    db.collection('ferias')
        .where('activa', '==', true)
        .onSnapshot(snap => {
            if (snap.empty) {
                container.innerHTML = '';
                if (sinEventos) sinEventos.classList.remove('hidden');
                return;
            }

            if (sinEventos) sinEventos.classList.add('hidden');

            // Ordenamos acá (en vez de con .orderBy en la consulta) para no
            // necesitar crear un índice compuesto en Firestore para
            // "activa + createdAt". Los timestamps de Firestore tienen
            // .toMillis(); si por algo faltara, los mandamos al final.
            const docsOrdenados = [...snap.docs].sort((a, b) => {
                const ca = a.data().createdAt;
                const cb = b.data().createdAt;
                const ma = ca && ca.toMillis ? ca.toMillis() : 0;
                const mb = cb && cb.toMillis ? cb.toMillis() : 0;
                return ma - mb;
            });

            container.innerHTML = docsOrdenados.map((doc, i) => {
                const feria = doc.data();
                const flyerUrl = escaparHtml(feria.flyerUrl || '');
                const tituloEscapado = escaparHtml(feria.titulo || '');
                const etiqueta = i === 0 ? 'Próxima Edición' : 'Siguiente Feria';

                return `
                <div class="bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/50 overflow-hidden border border-slate-100 flex flex-col md:flex-row transition-all hover:shadow-yellow-200/20">

                    <div class="relative w-full md:w-2/5 h-64 md:h-auto overflow-hidden">
                        <div onclick="abrirFoto('${flyerUrl}')" class="relative group cursor-pointer w-full h-full">
                            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center gap-2 z-20">
                                <i class="fas fa-search-plus text-white text-3xl"></i>
                                <span class="text-white text-[10px] font-black uppercase tracking-widest">Ver flyer completo</span>
                            </div>
                            <img src="${flyerUrl}" class="w-full h-full object-cover" alt="Flyer de ${tituloEscapado}">
                        </div>

                        <div class="absolute top-6 left-6 bg-white rounded-2xl shadow-xl p-3 text-center min-w-[70px] z-10">
                            <p class="text-xs font-black uppercase text-slate-400 leading-none mb-1">${escaparHtml(feria.mes)}</p>
                            <p class="text-3xl font-black text-black leading-none">${escaparHtml(feria.diaNumero)}</p>
                        </div>

                        <div class="absolute bottom-4 left-4 z-10">
                            <span class="bg-yellow-comunidad text-black text-[10px] font-black uppercase px-3 py-1 rounded-full shadow-lg">
                                ${etiqueta}
                            </span>
                        </div>
                    </div>

                    <div class="w-full md:w-3/5 p-8 md:p-12 flex flex-col justify-center">
                        <div class="flex items-center gap-2 mb-4">
                            <div class="h-1 w-10 bg-yellow-comunidad rounded-full"></div>
                            <span class="text-yellow-600 font-bold text-xs uppercase tracking-tighter">${escaparHtml(feria.diaSemana)}</span>
                        </div>

                        <h3 class="text-3xl md:text-4xl font-black text-slate-900 mb-6 leading-tight">${tituloEscapado}</h3>

                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-xl bg-yellow-50 flex items-center justify-center flex-shrink-0">
                                    <i class="fas fa-clock text-yellow-600"></i>
                                </div>
                                <div>
                                    <p class="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Horario</p>
                                    <p class="text-slate-700 font-bold">${escaparHtml(feria.horario)}</p>
                                </div>
                            </div>
                            <div class="flex items-start gap-3">
                                <div class="w-10 h-10 rounded-xl bg-yellow-50 flex items-center justify-center flex-shrink-0">
                                    <i class="fas fa-map-marker-alt text-yellow-600"></i>
                                </div>
                                <div>
                                    <p class="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Ubicación</p>
                                    <p class="text-slate-700 font-bold">${escaparHtml(feria.ubicacion)}</p>
                                </div>
                            </div>
                        </div>

                        <div class="flex flex-col sm:flex-row gap-4">
                            ${feria.mapaEmbedUrl ? `
                            <button onclick="abrirMapa('${escaparHtml(feria.mapaEmbedUrl)}')"
                                    class="flex-1 bg-black text-white py-4 rounded-2xl font-black text-sm hover:bg-slate-800 transition shadow-xl shadow-black/10 flex items-center justify-center gap-2">
                                <i class="fas fa-location-dot"></i> Ver ubicación
                            </button>` : ''}
                            <a href="#contacto" class="flex-1 bg-yellow-comunidad text-black py-4 rounded-2xl font-black text-sm hover:bg-yellow-500 transition shadow-xl shadow-yellow-200 flex items-center justify-center gap-2 uppercase">
                                Quiero participar
                            </a>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }, err => {
            console.error('Error al escuchar las ferias activas:', err);
            container.innerHTML = mensajeErrorCarga('text-center');
            if (sinEventos) sinEventos.classList.add('hidden');
        });
}

/* ---------- 2. GALERÍA DE FOTOS ---------- */
function escucharGaleria() {
    const container = document.getElementById('gallery-container');
    const vacio = document.getElementById('gallery-empty');
    if (!container) return;

    db.collection('galeria').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            vacio.classList.remove('hidden');
            return;
        }

        vacio.classList.add('hidden');
        container.innerHTML = snap.docs.map(doc => {
            const foto = doc.data();
            const url = escaparHtml(foto.url);
            return `
                <div class="flex-none w-[80%] sm:w-[45%] lg:w-[30%] snap-center">
                    <div onclick="abrirFoto('${url}')" class="relative group cursor-pointer overflow-hidden rounded-[1.5rem] md:rounded-[2rem] shadow-md">
                        <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center gap-2 z-10">
                            <i class="fas fa-search-plus text-white text-2xl"></i>
                            <span class="text-white text-[10px] font-black uppercase tracking-widest">Ver foto</span>
                        </div>
                        <img src="${url}" class="w-full h-[300px] md:h-[400px] object-cover transform group-hover:scale-105 transition duration-500" alt="${escaparHtml(foto.alt || 'Foto de la feria')}">
                    </div>
                </div>`;
        }).join('');

        window.actualizarImagenesGaleria();
    }, err => {
        console.error('Error al escuchar la galería:', err);
        container.innerHTML = mensajeErrorCarga();
        if (vacio) vacio.classList.add('hidden');
    });
}

/* ---------- 3. EMPRENDEDORES PARTICIPANTES + TESTIMONIOS ---------- */
function escucharEmprendedores() {
    const container = document.getElementById('carousel-container');
    const testimoniosContainer = document.getElementById('testimonios-container');
    const testimoniosVacio = document.getElementById('testimonios-empty');
    if (!container) return;

    db.collection('emprendedores').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            if (testimoniosContainer) testimoniosContainer.innerHTML = '';
            if (testimoniosVacio) testimoniosVacio.classList.remove('hidden');
            return;
        }

        // Guardamos los datos completos (incluye instagram, whatsapp y web)
        // en un array global para que abrirEmprendedor(index), en app.js,
        // pueda mostrarlos en el modal sin tener que ir a buscarlos de
        // nuevo a Firestore.
        window.__emprendedoresData = snap.docs.map(doc => doc.data());

        // Importante: acá se pinta el set "original" (sin duplicar). La
        // duplicación para el efecto de scroll infinito la hace
        // iniciarCarruselInfinito() en app.js.
        container.innerHTML = snap.docs.map((doc, i) => {
            const e = doc.data();
            return `
                <div class="flex-none w-36 md:w-40 cursor-pointer pointer-events-auto" onclick="abrirEmprendedor(${i})">
                    <div class="relative w-28 h-28 md:w-32 md:h-32 mx-auto mb-4 group">
                        <div class="w-full h-full rounded-full border-4 border-yellow-comunidad p-1 shadow-md transition-transform duration-300 group-hover:scale-105">
                            ${imgConLoader(e.logoUrl, e.nombre, 'w-full h-full object-cover rounded-full bg-slate-100')}
                        </div>
                        <span class="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-yellow-comunidad border-2 border-white shadow-md flex items-center justify-center">
                            <i class="fas fa-info text-black text-[10px]"></i>
                        </span>
                    </div>
                    <p class="font-bold text-base md:text-lg">${escaparHtml(e.nombre)}</p>
                    <span class="text-xs uppercase tracking-widest text-slate-400">${escaparHtml(e.categoria || '')}</span>
                </div>`;
        }).join('');

        window.iniciarCarruselInfinito();

        // "Lo que dicen nuestros emprendedores": solo los que cargaron un testimonio.
        // Con 35+ testimonios el bloque hacía la página kilométrica, así que
        // mostramos solo los primeros LIMITE_INICIAL y el resto queda guardado
        // en window.__testimoniosRestantes para desplegarse con el botón
        // "Ver más testimonios" (mostrarMasTestimonios(), en app.js).
        if (testimoniosContainer) {
            const conTestimonio = snap.docs.filter(doc => (doc.data().testimonio || '').trim().length > 0);
            const btnMasTestimonios = document.getElementById('btn-mas-testimonios');
            const LIMITE_INICIAL_TESTIMONIOS = 6;

            if (!conTestimonio.length) {
                testimoniosContainer.innerHTML = '';
                if (testimoniosVacio) testimoniosVacio.classList.remove('hidden');
                if (btnMasTestimonios) btnMasTestimonios.classList.add('hidden');
            } else {
                if (testimoniosVacio) testimoniosVacio.classList.add('hidden');

                const tarjetasHtml = conTestimonio.map(doc => {
                    const e = doc.data();
                    return `
                        <div class="bg-slate-50 p-8 rounded-[2rem] shadow-sm relative italic text-slate-600">
                            <i class="fas fa-quote-left text-yellow-400 text-3xl absolute top-6 left-6 opacity-30"></i>
                            <p class="relative z-10 mb-6 mt-4">"${escaparHtml(e.testimonio)}"</p>
                            <div class="flex items-center justify-center gap-3 not-italic">
                                <div class="w-10 h-10 flex-shrink-0">${imgConLoader(e.logoUrl, e.nombre, 'w-10 h-10 rounded-full object-cover border-2 border-yellow-comunidad')}</div>
                                <div class="text-left leading-tight">
                                    <p class="font-bold text-black text-sm">${escaparHtml(e.nombre)}</p>
                                    <p class="text-xs text-slate-400">${escaparHtml(e.categoria || '')}</p>
                                </div>
                            </div>
                        </div>`;
                });

                testimoniosContainer.innerHTML = tarjetasHtml.slice(0, LIMITE_INICIAL_TESTIMONIOS).join('');
                window.__testimoniosRestantes = tarjetasHtml.slice(LIMITE_INICIAL_TESTIMONIOS);

                if (btnMasTestimonios) {
                    if (window.__testimoniosRestantes.length) {
                        btnMasTestimonios.classList.remove('hidden');
                        btnMasTestimonios.querySelector('span').textContent = `Ver más testimonios (${window.__testimoniosRestantes.length})`;
                    } else {
                        btnMasTestimonios.classList.add('hidden');
                    }
                }
            }
        }
    }, err => {
        console.error('Error al escuchar emprendedores:', err);
        container.innerHTML = mensajeErrorCarga();
        if (testimoniosContainer) testimoniosContainer.innerHTML = mensajeErrorCarga('col-span-full text-center');
        if (testimoniosVacio) testimoniosVacio.classList.add('hidden');
    });
}

/* ---------- 4. COMERCIOS ADHERIDOS ---------- */
// Igual que escucharEmprendedores(), pero sin testimonio: los comercios
// están adheridos y no participan directamente de la feria, así que no
// se muestran en "Lo que dicen nuestros emprendedores".
function escucharComercios() {
    const container = document.getElementById('comercios-container');
    if (!container) return;

    db.collection('comercios').orderBy('orden', 'asc').onSnapshot(snap => {
        if (snap.empty) {
            container.innerHTML = '';
            return;
        }

        // Guardamos los datos completos (incluye el descuento) en un array
        // global para que abrirComercio(index), en app.js, pueda mostrarlos
        // en el modal sin tener que ir a buscarlos de nuevo a Firestore.
        window.__comerciosData = snap.docs.map(doc => doc.data());

        // Importante: acá se pinta el set "original" (sin duplicar). La
        // duplicación para el efecto de scroll infinito la hace
        // iniciarCarruselInfinito() en app.js.
        container.innerHTML = snap.docs.map((doc, i) => {
            const c = doc.data();
            return `
                <div class="flex-none w-36 md:w-40 cursor-pointer pointer-events-auto" onclick="abrirComercio(${i})">
                    <div class="relative w-28 h-28 md:w-32 md:h-32 mx-auto mb-4 group">
                        <div class="w-full h-full rounded-full border-4 border-slate-800 p-1 shadow-md transition-transform duration-300 group-hover:scale-105">
                            ${imgConLoader(c.logoUrl, c.nombre, 'w-full h-full object-cover rounded-full bg-slate-100')}
                        </div>
                        <span class="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-slate-800 border-2 border-white shadow-md flex items-center justify-center">
                            <i class="fas fa-info text-white text-[10px]"></i>
                        </span>
                    </div>
                    <p class="font-bold text-base md:text-lg">${escaparHtml(c.nombre)}</p>
                    <span class="text-xs uppercase tracking-widest text-slate-400">${escaparHtml(c.categoria || '')}</span>
                </div>`;
        }).join('');

        window.iniciarCarruselInfinito('comercios-container');
    }, err => {
        console.error('Error al escuchar comercios:', err);
        container.innerHTML = mensajeErrorCarga();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    escucharFeriaActiva();
    escucharGaleria();
    escucharEmprendedores();
    escucharComercios();
});
