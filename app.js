document.addEventListener('DOMContentLoaded', () => {

    // 0. CORRECCIÓN DE SCROLL PARA LINKS DIRECTOS A UNA SECCIÓN (ej. #comercios)
    // Las secciones de arriba (galería, ferias, emprendedores, testimonios) se
    // llenan con datos de Firestore en tiempo real y sin orden garantizado. Si
    // alguien entra con un link directo a una sección más abajo (ej. desde el
    // botón "Beneficios" del dashboard de emprendedores), el navegador hace el
    // scroll al ancla ANTES de que ese contenido termine de cargar; a medida
    // que va llegando, la página crece por arriba y la sección objetivo se
    // corre hacia abajo, dando la sensación de que la página "scrollea para
    // arriba" sola. Acá reintentamos el scroll cada vez que cambia el
    // contenido de las secciones de arriba, hasta que todo se estabiliza o el
    // usuario interactúa por su cuenta (ahí dejamos de forzarlo).
    //
    // Se extrae a una función reutilizable porque el mismo problema pasa con
    // el botón interno "Descuentos para emprendedores" (href="#comercios"):
    // el salto nativo del navegador ocurre una sola vez, apenas se hace clic,
    // así que si en ese momento las secciones de arriba todavía están
    // cargando, el usuario también termina en un punto incorrecto.
    const corregirScrollHaciaSeccion = (target) => {
        if (!target) return;
        let activo = true;
        const reintentarScroll = () => {
            if (activo) target.scrollIntoView({ behavior: 'auto', block: 'start' });
        };
        const observer = new MutationObserver(() => requestAnimationFrame(reintentarScroll));
        const cancelar = () => { activo = false; observer.disconnect(); };

        ['gallery-container', 'ferias-container', 'carousel-container', 'testimonios-container', 'comercios-container']
            .forEach(id => {
                const el = document.getElementById(id);
                if (el) observer.observe(el, { childList: true });
            });

        // Si el usuario scrollea o toca la pantalla por su cuenta, dejamos
        // de pelearle el scroll: la corrección era solo para el aterrizaje.
        window.addEventListener('wheel', cancelar, { once: true, passive: true });
        window.addEventListener('touchstart', cancelar, { once: true, passive: true });

        reintentarScroll();
        setTimeout(cancelar, 4000); // corte de seguridad
    };

    // 0.a Aterrizaje directo con hash en la URL (ej. link externo del dashboard)
    if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) corregirScrollHaciaSeccion(target);
    }

    // 0.b Clic en el botón interno "Descuentos para emprendedores" (#comercios)
    // estando ya parado en la página. Frenamos el salto nativo del navegador
    // (que se dispara una sola vez, antes de que termine de cargar el
    // contenido de arriba) y hacemos nosotros el scroll con reintento.
    const btnDescuentos = document.getElementById('btn-descuentos');
    if (btnDescuentos) {
        btnDescuentos.addEventListener('click', (e) => {
            const targetId = btnDescuentos.getAttribute('href').slice(1);
            const target = document.getElementById(targetId);
            if (!target) return; // sin target, dejamos el comportamiento default
            e.preventDefault();
            history.pushState(null, '', `#${targetId}`);
            corregirScrollHaciaSeccion(target);
        });
    }

    // 1. LÓGICA DEL BOTÓN SCROLL TOP
    const scrollTopBtn = document.getElementById('scroll-top-btn');
    if (scrollTopBtn) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                scrollTopBtn.classList.add('visible');
            } else {
                scrollTopBtn.classList.remove('visible');
            }
        });
        scrollTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // 2. CARRUSEL INFINITO Y FLUIDO (EMPRENDEDORES Y COMERCIOS)
    // Expuesta globalmente porque el contenido real se carga después, en tiempo
    // real desde Firestore (ver site-data.js), y puede volver a llamarse cada
    // vez que cambian los emprendedores/comercios (alta/baja/edición desde el admin).
    // Recibe el id del contenedor para poder reutilizarla en ambas secciones;
    // por compatibilidad, si no se pasa nada, usa "carousel-container" (emprendedores).
    const carruselAnimationIds = {};
    window.iniciarCarruselInfinito = function iniciarCarruselInfinito(containerId = 'carousel-container') {
        const container = document.getElementById(containerId);
        if (!container || !container.children.length) return;

        // Si ya había un loop de scroll corriendo (de una carga anterior),
        // lo cancelamos para no acumular loops duplicados.
        if (carruselAnimationIds[containerId]) {
            cancelAnimationFrame(carruselAnimationIds[containerId]);
            carruselAnimationIds[containerId] = null;
        }
        container.scrollLeft = 0;

        // Con pocos elementos, todos entran en pantalla sin necesidad de
        // scroll: si duplicáramos igual, se verían literalmente repetidos.
        // Solo duplicamos (y animamos) cuando el contenido real desborda el
        // contenedor y hace falta el efecto de loop infinito.
        const necesitaLoop = container.scrollWidth > container.clientWidth;

        if (!necesitaLoop) {
            container.classList.add('justify-center');
            return;
        }
        container.classList.remove('justify-center');

        container.innerHTML = container.innerHTML + container.innerHTML;
        let scrollPos = 0;
        const speed = 0.5;

        function autoScroll() {
            scrollPos += speed;
            if (scrollPos >= container.scrollWidth / 2) {
                scrollPos = 0;
            }
            container.scrollLeft = scrollPos;
            carruselAnimationIds[containerId] = requestAnimationFrame(autoScroll);
        }
        carruselAnimationIds[containerId] = requestAnimationFrame(autoScroll);
    };

    // 3. LÓGICA DE PREGUNTAS FRECUENTES (FAQ ACCORDION)
    // El alto de la respuesta se calcula en JS (answer.scrollHeight) en vez de
    // usar un max-height fijo en el CSS: así la animación siempre dura lo mismo
    // sin importar si la respuesta es corta o larga, y no se siente "lenta".
    document.querySelectorAll('.faq-item').forEach(item => {
        const btn = item.querySelector('.faq-btn');
        const answer = item.querySelector('.faq-answer');
        if (!btn || !answer) return;

        // Arrancamos siempre cerrado con un valor explícito en píxeles (no "none"),
        // para que la transición funcione tanto al abrir como al cerrar.
        answer.style.maxHeight = '0px';

        btn.addEventListener('click', () => {
            const abriendo = !item.classList.contains('active');
            item.classList.toggle('active', abriendo);
            answer.style.maxHeight = abriendo ? answer.scrollHeight + 'px' : '0px';
        });
    });

    // 4. FUNCIONAMIENTO DE LOS BOTONES DEL BANNER (HERO)
    const btnParticipar = document.getElementById('btn-participar');
    const btnFeria = document.getElementById('btn-feria');

    if (btnParticipar) {
        btnParticipar.onclick = () => {
            document.getElementById('contacto').scrollIntoView({ behavior: 'smooth' });
        };
    }

    if (btnFeria) {
        btnFeria.onclick = () => {
            document.getElementById('seccion-feria').scrollIntoView({ behavior: 'smooth' });
        };
    }

    // 5. (Antes acá había un efecto que ocultaba cada sección (opacity 0) hasta
    // que el usuario la hacía aparecer scrolleando. Se sacó: ahora todo el
    // contenido está visible de entrada, sin depender del scroll.)

    // 6. LÓGICA DEL CARRUSEL DE GALERÍA DE FOTOS
    const galleryContainer = document.getElementById('gallery-container');
    const galleryNext = document.getElementById('gallery-next');
    const galleryPrev = document.getElementById('gallery-prev');

    if (galleryContainer && galleryNext && galleryPrev) {
        galleryNext.addEventListener('click', () => {
            galleryContainer.scrollBy({ left: galleryContainer.offsetWidth * 0.8, behavior: 'smooth' });
        });
        galleryPrev.addEventListener('click', () => {
            galleryContainer.scrollBy({ left: -galleryContainer.offsetWidth * 0.8, behavior: 'smooth' });
        });
    }
});

// 7. FUNCIONES GLOBALES PARA EL MODAL DEL MAPA
function abrirMapa(urlEmbed) {
    const modal = document.getElementById('modal-mapa');
    const iframe = document.getElementById('iframe-mapa');
    const loader = document.getElementById('map-loader');
    const linkExterno = document.getElementById('link-google-maps');

    if (modal && iframe) {
        iframe.classList.add('opacity-0');
        if (loader) loader.classList.remove('hidden');
        
        iframe.src = urlEmbed;
        if (linkExterno) linkExterno.href = urlEmbed.replace('embed?', 'view?'); 
        
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';
    }
}

function quitarLoader() {
    const loader = document.getElementById('map-loader');
    const iframe = document.getElementById('iframe-mapa');
    if (loader) loader.classList.add('hidden');
    if (iframe) iframe.classList.remove('opacity-0');
}

function cerrarMapa() {
    const modal = document.getElementById('modal-mapa');
    const iframe = document.getElementById('iframe-mapa');
    if (modal && iframe) {
        iframe.src = "";
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        document.body.style.overflow = 'auto';
    }
}

// 7.5 MODAL DE DETALLE DE COMERCIO (logo, categoría y descuento)
// Los datos ya están en memoria (window.__comerciosData, llenado por
// site-data.js), así que abrir el modal es instantáneo, sin ir a Firestore.
function abrirComercio(index) {
    const datos = window.__comerciosData || [];
    const c = datos[index];
    const modal = document.getElementById('modal-comercio');
    if (!modal || !c) return;

    document.getElementById('comercio-logo').src = c.logoUrl || '';
    document.getElementById('comercio-nombre').textContent = c.nombre || '';
    document.getElementById('comercio-categoria').textContent = c.categoria || '';

    // Ubicación: opcional, se muestra como texto debajo de la categoría.
    const ubicacionWrap = document.getElementById('comercio-ubicacion');
    const ubicacion = (c.ubicacion || '').trim();
    if (ubicacion) {
        document.getElementById('comercio-ubicacion-texto').textContent = ubicacion;
        ubicacionWrap.classList.remove('hidden');
    } else {
        ubicacionWrap.classList.add('hidden');
    }

    // Redes: WhatsApp, Instagram y el botón "Cómo llegar" son opcionales,
    // cada uno se muestra solo si el comercio tiene ese dato cargado desde
    // el admin.
    const redesWrap = document.getElementById('comercio-redes');
    const btnWhatsapp = document.getElementById('comercio-whatsapp');
    const btnInstagram = document.getElementById('comercio-instagram');
    const btnMapa = document.getElementById('comercio-mapa');

    if (ubicacion) {
        btnMapa.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ubicacion)}`;
        btnMapa.classList.remove('hidden');
    } else {
        btnMapa.classList.add('hidden');
    }

    const whatsapp = (c.whatsapp || '').trim();
    if (whatsapp) {
        const soloNumeros = whatsapp.replace(/\D/g, '');
        // WhatsApp para celulares argentinos necesita el prefijo 549 antes
        // del número de área. Si el usuario ya cargó el 54 o el 549 al
        // principio, lo sacamos primero para no duplicarlo.
        const numeroLimpio = soloNumeros.replace(/^549?/, '');
        btnWhatsapp.href = `https://wa.me/549${numeroLimpio}`;
        btnWhatsapp.classList.remove('hidden');
    } else {
        btnWhatsapp.classList.add('hidden');
    }

    const instagram = (c.instagram || '').trim();
    if (instagram) {
        let url = instagram;
        if (!/^https?:\/\//i.test(url)) {
            const usuario = url.replace(/^@/, '');
            url = `https://instagram.com/${usuario}`;
        }
        btnInstagram.href = url;
        btnInstagram.classList.remove('hidden');
    } else {
        btnInstagram.classList.add('hidden');
    }

    redesWrap.classList.toggle('hidden', !whatsapp && !instagram && !ubicacion);

    const descuentoWrap = document.getElementById('comercio-descuento-wrap');
    const descuentoTexto = document.getElementById('comercio-descuento');
    if (c.descuento && c.descuento.trim().length > 0) {
        descuentoTexto.textContent = c.descuento;
        descuentoWrap.classList.remove('hidden');
    } else {
        descuentoWrap.classList.add('hidden');
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';
}

function cerrarComercio() {
    const modal = document.getElementById('modal-comercio');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        document.body.style.overflow = 'auto';
    }
}

// 7.55 "VER MÁS TESTIMONIOS"
// site-data.js solo pinta los primeros testimonios y deja el resto en
// window.__testimoniosRestantes (como HTML ya armado) para no hacer la
// página larguísima con los 35 testimonios de entrada. Este botón agrega
// el resto al final del grid existente y se oculta.
function mostrarMasTestimonios() {
    const container = document.getElementById('testimonios-container');
    const btn = document.getElementById('btn-mas-testimonios');
    const restantes = window.__testimoniosRestantes || [];

    if (container && restantes.length) {
        container.insertAdjacentHTML('beforeend', restantes.join(''));
    }
    if (btn) btn.classList.add('hidden');
    window.__testimoniosRestantes = [];
}

// 7.6 MODAL DE DETALLE DE EMPRENDEDOR (logo, categoría, instagram, whatsapp y web)
// Igual que abrirComercio(), pero leyendo de window.__emprendedoresData
// (llenado por site-data.js) y sin sección de descuento.
function abrirEmprendedor(index) {
    const datos = window.__emprendedoresData || [];
    const e = datos[index];
    const modal = document.getElementById('modal-emprendedor');
    if (!modal || !e) return;

    document.getElementById('emprendedor-logo').src = e.logoUrl || '';
    document.getElementById('emprendedor-nombre').textContent = e.nombre || '';
    document.getElementById('emprendedor-categoria').textContent = e.categoria || '';

    // Redes: WhatsApp, Instagram y página web son opcionales, cada uno se
    // muestra solo si el emprendedor tiene ese dato cargado desde el admin.
    const redesWrap = document.getElementById('emprendedor-redes');
    const btnWhatsapp = document.getElementById('emprendedor-whatsapp');
    const btnInstagram = document.getElementById('emprendedor-instagram');
    const btnWeb = document.getElementById('emprendedor-web');

    const whatsapp = (e.whatsapp || '').trim();
    if (whatsapp) {
        const soloNumeros = whatsapp.replace(/\D/g, '');
        // WhatsApp para celulares argentinos necesita el prefijo 549 antes
        // del número de área. Si el usuario ya cargó el 54 o el 549 al
        // principio, lo sacamos primero para no duplicarlo.
        const numeroLimpio = soloNumeros.replace(/^549?/, '');
        btnWhatsapp.href = `https://wa.me/549${numeroLimpio}`;
        btnWhatsapp.classList.remove('hidden');
    } else {
        btnWhatsapp.classList.add('hidden');
    }

    const instagram = (e.instagram || '').trim();
    if (instagram) {
        let url = instagram;
        if (!/^https?:\/\//i.test(url)) {
            const usuario = url.replace(/^@/, '');
            url = `https://instagram.com/${usuario}`;
        }
        btnInstagram.href = url;
        btnInstagram.classList.remove('hidden');
    } else {
        btnInstagram.classList.add('hidden');
    }

    const web = (e.web || '').trim();
    if (web) {
        let url = web;
        if (!/^https?:\/\//i.test(url)) {
            url = `https://${url}`;
        }
        btnWeb.href = url;
        btnWeb.classList.remove('hidden');
    } else {
        btnWeb.classList.add('hidden');
    }

    redesWrap.classList.toggle('hidden', !whatsapp && !instagram && !web);

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';
}

function cerrarEmprendedor() {
    const modal = document.getElementById('modal-emprendedor');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        document.body.style.overflow = 'auto';
    }
}

window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('modal-comercio');
    if (e.key === "Escape" && modal && !modal.classList.contains('hidden')) cerrarComercio();
    const modalEmprendedor = document.getElementById('modal-emprendedor');
    if (e.key === "Escape" && modalEmprendedor && !modalEmprendedor.classList.contains('hidden')) cerrarEmprendedor();
});

window.onclick = function(event) {
    const modal = document.getElementById('modal-mapa');
    if (event.target == modal) {
        cerrarMapa();
    }
    const modalComercio = document.getElementById('modal-comercio');
    if (event.target == modalComercio) {
        cerrarComercio();
    }
    const modalEmprendedor = document.getElementById('modal-emprendedor');
    if (event.target == modalEmprendedor) {
        cerrarEmprendedor();
    }
}

// 8. LÓGICA PARA EL MODAL DE FOTOS CON NAVEGACIÓN
let imagenesGaleria = [];
let indiceActual = 0;

// Detecta todas las fotos disponibles en la galería. Se llama al cargar el DOM
// y de nuevo desde site-data.js cada vez que se renderizan fotos desde Firestore.
window.actualizarImagenesGaleria = function actualizarImagenesGaleria() {
    const imagenesHTML = document.querySelectorAll('#gallery-container img');
    imagenesGaleria = Array.from(imagenesHTML).map(img => img.getAttribute('src'));
};

document.addEventListener('DOMContentLoaded', () => {
    window.actualizarImagenesGaleria();
});

// Ajuste en la función abrirFoto para manejar imágenes fuera de la galería
function abrirFoto(src) {
    const modal = document.getElementById('modal-foto');
    const img = document.getElementById('img-ampliada');
    
    if (modal && img) {
        // Buscamos si la imagen está en la galería para habilitar flechas
        const index = imagenesGaleria.indexOf(src);
        indiceActual = index !== -1 ? index : 0; 
        
        img.src = src;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        document.body.style.overflow = 'hidden';

        // Opcional: Ocultar flechas si la imagen no es parte de la galería
        const flechas = modal.querySelectorAll('button[onclick^="cambiarFoto"]');
        flechas.forEach(f => f.style.display = index === -1 ? 'none' : 'block');
    }
}
function cambiarFoto(direccion) {
    const img = document.getElementById('img-ampliada');
    const caption = document.getElementById('caption-foto'); // Seleccionamos el texto
    
    indiceActual += direccion;
    
    if (indiceActual < 0) {
        indiceActual = imagenesGaleria.length - 1;
    } else if (indiceActual >= imagenesGaleria.length) {
        indiceActual = 0;
    }
    
    // Efecto de transición para imagen y texto
    img.style.opacity = '0';
    caption.style.opacity = '0';
    caption.style.transform = 'translateY(10px)';

    setTimeout(() => {
        img.src = imagenesGaleria[indiceActual];
        img.style.opacity = '1';
        
        // El texto aparece con un leve movimiento hacia arriba
        caption.style.opacity = '1';
        caption.style.transform = 'translateY(0)';
        caption.style.transition = 'all 0.4s ease';
    }, 150);
}

function cerrarFoto() {
    const modal = document.getElementById('modal-foto');
    const img = document.getElementById('img-ampliada');
    
    if (modal && img) {
        img.classList.remove('scale-100');
        img.classList.add('scale-95');
        
        setTimeout(() => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            document.body.style.overflow = 'auto';
            img.src = "";
        }, 200);
    }
}

// Control por teclado (Esc, Flechas Izquierda y Derecha)
window.addEventListener('keydown', (e) => {
    const modal = document.getElementById('modal-foto');
    if (modal && !modal.classList.contains('hidden')) {
        if (e.key === "Escape") cerrarFoto();
        if (e.key === "ArrowRight") cambiarFoto(1);
        if (e.key === "ArrowLeft") cambiarFoto(-1);
    }
});

// 9. SKELETONS DE CARGA (mientras llegan los datos de Firestore)
// No dependen de que site-data.js las llame explícitamente: se limpian solas
// apenas detectan contenido real, así que funcionan aunque cambie la forma
// en la que site-data.js arma el HTML.
document.addEventListener('DOMContentLoaded', () => {

    // Tiempo máximo que dejamos un skeleton visible aunque no haya llegado
    // contenido real (por ejemplo, si Firestore tarda o falla). Evita que
    // quede "cargando" para siempre.
    const SKELETON_TIMEOUT_MS = 15000;

    // 9.1 Contenedores donde el contenido real se agrega como hijos nuevos
    // (galería, emprendedores, testimonios): apenas aparece un hijo que no es
    // un skeleton, quitamos los placeholders.
    function observarSkeletonPorHijos(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const quitarSkeletons = () => {
            container.querySelectorAll('[data-skeleton]').forEach(el => el.remove());
        };

        const hayContenidoReal = () =>
            Array.from(container.children).some(el => !el.hasAttribute('data-skeleton'));

        if (hayContenidoReal()) {
            quitarSkeletons();
            return;
        }

        const observer = new MutationObserver(() => {
            if (hayContenidoReal()) {
                quitarSkeletons();
                observer.disconnect();
            }
        });
        observer.observe(container, { childList: true });

        setTimeout(() => {
            // Si a esta altura todavía no llegó contenido real (por ejemplo,
            // porque la conexión es lenta o Firestore no responde), en vez de
            // dejar la sección en blanco sin explicación mostramos un aviso
            // con un botón para reintentar. Si el contenido real llega
            // después de todos modos (site-data.js reemplaza el innerHTML
            // completo apenas responde Firestore), este aviso se reemplaza solo.
            if (!hayContenidoReal()) {
                quitarSkeletons();
                const aviso = document.createElement('p');
                aviso.className = 'text-slate-400 text-sm italic w-full text-center';
                aviso.innerHTML = 'Esto está tardando más de lo normal para cargar. <button onclick="location.reload()" class="underline font-bold text-yellow-600">Reintentar</button>';
                container.appendChild(aviso);
            }
            observer.disconnect();
        }, SKELETON_TIMEOUT_MS);
    }

    // 9.2 "ferias-container" ahora puede recibir una o varias tarjetas de
    // feria (antes era una sola tarjeta fija), así que usa el mismo
    // mecanismo por-hijos que galería/comercios/emprendedores.
    ['gallery-container', 'carousel-container', 'comercios-container', 'testimonios-container', 'ferias-container'].forEach(observarSkeletonPorHijos);
});
