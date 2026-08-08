// ============================================================
// COMPRESIÓN Y SUBIDA DE IMÁGENES
// ============================================================
// Se usa "var"/"function" (no const/let a nivel de módulo con posible
// doble inclusión) por la misma razón que en supabase-client.js.
//
// REGLAS (fotos de producto -> Supabase Storage):
//  - Formatos aceptados: JPG, JPEG, PNG, WebP
//  - Máximo 3 MB antes de comprimir
//  - Se redimensiona automáticamente (máx 1600x1600 px)
//  - Se convierte a WebP, calidad ~75-80%
//  - Peso final objetivo: 100-300 KB
//  - Todo se comprime en el navegador antes de subir
//
// Logo y portada del emprendedor van a Cloudinary (mismo pipeline de
// compresión en el navegador antes de subir, con su propio tamaño máximo).
// ------------------------------------------------------------

const IMG_TIPOS_ACEPTADOS = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const IMG_MAX_MB_ORIGINAL = 3;
const IMG_MAX_LADO_DEFAULT = 1600;
const IMG_PESO_OBJETIVO_MAX = 300 * 1024; // 300 KB
const IMG_CALIDAD_INICIAL = 0.8;
const IMG_CALIDAD_MINIMA = 0.5;

const CLOUDINARY_CLOUD_NAME = 'dhgrivib0';
const CLOUDINARY_UPLOAD_PRESET = 'comunidadplace';

const BUCKET_PRODUCTOS = 'productos-imagenes';

// ------------------------------------------------------------
// VALIDACIÓN
// ------------------------------------------------------------
// Devuelve null si el archivo es válido, o un mensaje de error si no.
function validarImagenSeleccionada(file) {
    if (!file) return 'No se seleccionó ningún archivo.';
    if (!IMG_TIPOS_ACEPTADOS.includes(file.type)) {
        return 'Formato no admitido. Usá JPG, PNG o WebP.';
    }
    if (file.size > IMG_MAX_MB_ORIGINAL * 1024 * 1024) {
        return `La imagen pesa demasiado (máx ${IMG_MAX_MB_ORIGINAL} MB antes de comprimir).`;
    }
    return null;
}

// ------------------------------------------------------------
// COMPRESIÓN EN EL NAVEGADOR
// ------------------------------------------------------------
function cargarImagenDesdeArchivo(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
    });
}

function canvasABlobWebp(canvas, calidad) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) { reject(new Error('No se pudo generar la imagen comprimida.')); return; }
            resolve(blob);
        }, 'image/webp', calidad);
    });
}

// Redimensiona (si hace falta), convierte a WebP y ajusta la calidad de forma
// iterativa (80% -> 50%) hasta acercarse al peso objetivo. Devuelve un Blob.
async function comprimirImagen(file, maxLado = IMG_MAX_LADO_DEFAULT) {
    const img = await cargarImagenDesdeArchivo(file);

    let { width, height } = img;
    if (width > maxLado || height > maxLado) {
        const escala = Math.min(maxLado / width, maxLado / height);
        width = Math.round(width * escala);
        height = Math.round(height * escala);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(img.src);

    let calidad = IMG_CALIDAD_INICIAL;
    let blob = await canvasABlobWebp(canvas, calidad);

    while (blob.size > IMG_PESO_OBJETIVO_MAX && calidad > IMG_CALIDAD_MINIMA) {
        calidad = Math.round((calidad - 0.1) * 100) / 100;
        blob = await canvasABlobWebp(canvas, calidad);
    }

    return blob;
}

// ------------------------------------------------------------
// SUPABASE STORAGE (fotos de producto)
// ------------------------------------------------------------
// Bucket requerido: "productos-imagenes" (público). Ver notas al pie del
// archivo para la configuración necesaria en el Dashboard de Supabase.
async function subirImagenProductoSupabase(file, emprendedorId) {
    const errorValidacion = validarImagenSeleccionada(file);
    if (errorValidacion) throw new Error(errorValidacion);

    const blob = await comprimirImagen(file, IMG_MAX_LADO_DEFAULT);
    const nombreArchivo = `${emprendedorId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;

    const { error } = await supabase.storage
        .from(BUCKET_PRODUCTOS)
        .upload(nombreArchivo, blob, { contentType: 'image/webp', upsert: false });

    if (error) throw error;

    const { data } = supabase.storage.from(BUCKET_PRODUCTOS).getPublicUrl(nombreArchivo);
    return data.publicUrl;
}

// Borra una imagen de producto del bucket a partir de su URL pública.
// No es crítico si falla (por eso no lanza error, solo loguea).
async function borrarImagenProductoSupabase(urlPublica) {
    if (!urlPublica) return;
    const marcador = `/${BUCKET_PRODUCTOS}/`;
    const idx = urlPublica.indexOf(marcador);
    if (idx === -1) return; // no es una imagen de este bucket (ej: URL vieja externa)
    const path = urlPublica.slice(idx + marcador.length);
    const { error } = await supabase.storage.from(BUCKET_PRODUCTOS).remove([path]);
    if (error) console.error('No se pudo borrar la imagen anterior del storage:', error);
}

// ------------------------------------------------------------
// CLOUDINARY (logo y portada del emprendedor)
// ------------------------------------------------------------
async function subirImagenCloudinary(file, maxLado = IMG_MAX_LADO_DEFAULT) {
    const errorValidacion = validarImagenSeleccionada(file);
    if (errorValidacion) throw new Error(errorValidacion);

    const blob = await comprimirImagen(file, maxLado);

    const formData = new FormData();
    formData.append('file', blob, 'imagen.webp');
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
        method: 'POST',
        body: formData
    });

    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || 'Error subiendo la imagen a Cloudinary.');
    }

    const data = await resp.json();
    return data.secure_url;
}

// ============================================================
// CONFIGURACIÓN NECESARIA EN SUPABASE (hacer una sola vez)
// ============================================================
// 1. Storage -> New bucket -> nombre: "productos-imagenes" -> Public bucket: SI
// 2. Storage -> "productos-imagenes" -> Policies -> New policy, agregar:
//
//    a) SELECT (lectura pública, para que la tienda pueda mostrar las fotos):
//       target roles: public
//       USING: true
//
//    b) INSERT (solo emprendedores logueados pueden subir, cada uno a su
//       propia carpeta, que es el primer segmento del path == su user id):
//       target roles: authenticated
//       WITH CHECK: (storage.foldername(name))[1] = auth.uid()::text
//
//    c) (opcional) DELETE con la misma condición que el INSERT, si querés
//       que se puedan borrar imágenes viejas al reemplazarlas:
//       target roles: authenticated
//       USING: (storage.foldername(name))[1] = auth.uid()::text
// ============================================================