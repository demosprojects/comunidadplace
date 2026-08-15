/* =========================================================
   CONFIGURACIÓN DE FIREBASE - Comunidad Emprendedora V.Ángela
   =========================================================
   1. Andá a https://console.firebase.google.com
   2. Creá un proyecto nuevo (o usá uno existente)
   3. Agregá una "app web" y pegá acá los datos que te da
   4. Habilitá Firestore Database (modo producción)
   5. Habilitá Authentication > Sign-in method > Email/Password
   6. Creá el usuario admin manualmente en Authentication > Users
   ========================================================= */

const firebaseConfig = {
    apiKey: "AIzaSyCNfq4lK42GR1T-3itdiuu2x3uIN0kaYnA",
    authDomain: "comunidad-landig.firebaseapp.com",
    projectId: "comunidad-landig",
    storageBucket: "comunidad-landig.firebasestorage.app",
    messagingSenderId: "137620477982",
    appId: "1:137620477982:web:837a1f4effd4abdc08b60f"
};

firebase.initializeApp(firebaseConfig);

// Variables globales disponibles para app.js, site-data.js y admin.js
const db = firebase.firestore();
const auth = firebase.auth();