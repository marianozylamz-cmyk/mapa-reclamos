// ==================== PAGE LOADER INIT ====================
const initPageLoader = () => {
    const MIN_SHOW_MS = 800;
    const MAX_WAIT_MS = 3500;
    
    const loader = document.getElementById('mp-page-loader');
    const body = document.body;
    
    if (!loader) return;
    
    // Agregar clase de "cargando" al body
    body.classList.add('mp-loading');
    
    // Tiempo mínimo de espera
    let minTimeReached = false;
    setTimeout(() => {
        minTimeReached = true;
        // Si ya está listo, remover inmediatamente
        if (window.mpLoaderReady) {
            hidePageLoader();
        }
    }, MIN_SHOW_MS);
    
    // Timeout máximo de respaldo (3.5 seg)
    window.mpLoaderTimeout = setTimeout(() => {
        hidePageLoader();
    }, MAX_WAIT_MS);
    
    // Función para ocultar el loader
    window.hidePageLoader = () => {
        if (!loader) return;
        
        clearTimeout(window.mpLoaderTimeout);
        
        loader.classList.add('mp-fade-out');
        body.classList.remove('mp-loading');
        
        // Eliminar del DOM después de la animación
        setTimeout(() => {
            if (loader.parentNode) {
                loader.parentNode.removeChild(loader);
            }
            window.mpLoaderReady = true;
        }, 400);
    };
    
    // Marcar como "ready" cuando el loader esté listo para ocultarse
    window.mpLoaderReady = false;
};

// Inicializar el loader
initPageLoader();

const OLAVARRIA_LAT = -36.8927;
const OLAVARRIA_LNG = -60.3225;
const OLAVARRIA_BOUNDS = {
    minLat: -36.99,
    maxLat: -36.75,
    minLng: -60.52,
    maxLng: -60.05
};

const CATEGORIES = {
    plazas: { label: 'Parques/Paseos/Plazas' },
    salud: { label: 'Salud' },
    alumbrado: { label: 'Alumbrado' },
    calle: { label: 'Bache/Calle/Camino' },
    basura: { label: 'Basura' },
    otro: { label: 'Otros' }
};

const state = {
    claims: [],
    adminClaims: [],
    mySessionPendingClaims: [],
    photoCache: {}, // fbId -> base64 | null (null = "ya consultamos, no tiene foto")
    photoFetchPromises: {}, // fbId -> Promise en curso (dedup de clicks rápidos)
    map: null,
    clusterGroup: null,
    markers: [],
    isAdmin: false,
    selectedCategory: null,
    currentLocation: null,
    currentPhoto: null,
    activeCategoryFilter: 'all',
    mapClickLocation: null,
    adminMoveLocation: null, // lat/lng nueva elegida por el admin al reubicar un reclamo (sin guardar aún)
    suspendMapClickToCreate: false // true mientras el admin está reubicando (ver startAdminLocationPick)
};

document.addEventListener('DOMContentLoaded', async () => {
    initAuthListener();
    await loadPublicClaims();
    state.mySessionPendingClaims = pruneResolvedLocalTrackedClaims();
    initLeafletMap();
    setupApplicationEvents();
    renderPublicClaimsList();
    initPoliticalCounter();
    handleDeepLinking();
    
    // ← AGREGAR ESTA LÍNEA: Ocultar loader después de que todo esté listo
    if (typeof hidePageLoader === 'function') {
        setTimeout(() => hidePageLoader(), 200);
    }
});

// ---------------------------------------------------------------------------
// AUTENTICACIÓN ADMIN
// ---------------------------------------------------------------------------

function initAuthListener() {
    const { onAuthStateChanged } = window.authMethods;

    onAuthStateChanged(window.auth, async (user) => {
        if (!user) {
            state.isAdmin = false;
            state.adminClaims = [];
            document.getElementById('adminSessionBar').style.display = 'none';
            document.getElementById('adminPanel').classList.add('hidden');
            if (state.map) renderMapPins();
            return;
        }

        try {
            const tokenResult = await user.getIdTokenResult();
            if (tokenResult.claims.admin === true) {
                state.isAdmin = true;
                document.getElementById('adminSessionBar').style.display = 'flex';
                await loadAdminClaims();
                syncAdminDashboard();
                renderMapPins();
                renderPublicClaimsList();
            } else {
                state.isAdmin = false;
                document.getElementById('adminSessionBar').style.display = 'none';
            }
        } catch (error) {
            console.error('Error verificando sesión admin:', error);
            state.isAdmin = false;
        }
    });
}

async function handleAdminLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const errorEl = document.getElementById('adminLoginError');
    const btn = document.getElementById('adminLoginBtn');

    errorEl.style.display = 'none';

    if (!email || !password) {
        errorEl.textContent = 'Completá email y contraseña';
        errorEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Ingresando...';

    try {
        const { signInWithEmailAndPassword } = window.authMethods;
        await signInWithEmailAndPassword(window.auth, email, password);
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminEmail').value = '';
        document.getElementById('adminPassword').value = '';
    } catch (error) {
        console.error('Error de login:', error);
        errorEl.textContent = 'Email o contraseña incorrectos';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Ingresar';
    }
}

async function handleAdminLogout() {
    const { signOut } = window.authMethods;
    try {
        await signOut(window.auth);
    } catch (error) {
        console.error('Error al salir:', error);
    }
    window.location.href = window.location.pathname;
}

// ---------------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// SEGUIMIENTO LOCAL DE "MIS RECLAMOS"
// Los reclamos pendientes solo existen en memoria (`mySessionPendingClaims`) hasta
// que un admin los aprueba/rechaza — el ciudadano no tiene permiso de leer la
// colección privada "reclamos". Para que no se pierdan al refrescar la página o
// cerrar la pestaña, los guardamos localmente en este mismo navegador.
// ---------------------------------------------------------------------------

const MY_CLAIMS_STORAGE_KEY = 'mp_my_pending_claims';
// Cuánto mostramos el pin gris de "tu reclamo, pendiente de revisión" en este
// navegador. Pasado este plazo lo descartamos aunque el admin nunca lo haya
// tocado — un rechazo/borrado no le llega al vecino de otra forma, así que sin
// esto el pin le queda pegado para siempre. 72hs es tiempo de sobra para ver
// el propio reclamo ya confirmado.
const MY_CLAIMS_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function saveClaimToLocalTracking(claimData) {
    try {
        const list = JSON.parse(localStorage.getItem(MY_CLAIMS_STORAGE_KEY) || '[]');
        list.push(claimData);
        localStorage.setItem(MY_CLAIMS_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        // localStorage lleno/deshabilitado: no bloqueamos el envío del reclamo por esto
    }
}

function loadLocalTrackedClaims() {
    try {
        return JSON.parse(localStorage.getItem(MY_CLAIMS_STORAGE_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

// Si un reclamo trackeado localmente ya aparece como público (fue aprobado o
// solucionado), o ya pasaron MY_CLAIMS_MAX_AGE_MS desde que se creó, dejamos de
// mostrarlo como "pendiente" — en el primer caso ya se ve normal en el mapa; en
// el segundo, cubre el caso de rechazo/borrado (que el vecino no puede ver de
// otra forma) para que el pin gris no le quede pegado para siempre.
function pruneResolvedLocalTrackedClaims() {
    const publicClaimIds = new Set(state.claims.map(c => c.claimId));
    const now = Date.now();
    const remaining = loadLocalTrackedClaims().filter(c => {
        if (publicClaimIds.has(c.claimId)) return false;
        const createdAtMs = c.createdAt ? new Date(c.createdAt).getTime() : NaN;
        if (!Number.isFinite(createdAtMs)) return false; // sin timestamp: no sabemos la edad, lo descartamos
        return (now - createdAtMs) < MY_CLAIMS_MAX_AGE_MS;
    });
    try {
        localStorage.setItem(MY_CLAIMS_STORAGE_KEY, JSON.stringify(remaining));
    } catch (e) { /* ignorar */ }
    return remaining;
}

function findClaimById(fbId) {
    if (state.isAdmin) {
        const fromAdmin = state.adminClaims.find(c => c._fbId === fbId);
        if (fromAdmin) return fromAdmin;
    }
    const fromSession = state.mySessionPendingClaims.find(c => c._fbId === fbId);
    if (fromSession) return fromSession;
    return state.claims.find(c => c._fbId === fbId);
}

function handleDeepLinking() {
    const params = new URLSearchParams(window.location.search);
    const claimId = params.get('claim');

    // Entrada directa y "bookmarkeable" al login admin (?admin=1), en vez de depender
    // únicamente del link discreto del footer.
    if (params.get('admin') === '1') {
        document.getElementById('adminLoginModal').classList.remove('hidden');
    }

    if (claimId) {
        const claim = state.claims.find(c => c.claimId === claimId);
        if (claim) {
            setTimeout(() => {
                if (state.map) {
                    state.map.setView([claim.lat, claim.lng], 16);
                }
                globalOpenDetailWindow(claim._fbId);
            }, 500);
        }
    }
}

function isWithinOlavarria(lat, lng) {
    return lat >= OLAVARRIA_BOUNDS.minLat &&
           lat <= OLAVARRIA_BOUNDS.maxLat &&
           lng >= OLAVARRIA_BOUNDS.minLng &&
           lng <= OLAVARRIA_BOUNDS.maxLng;
}

function initLeafletMap() {
    state.map = L.map('map', { zoomControl: false }).setView([OLAVARRIA_LAT, OLAVARRIA_LNG], 14);
    L.control.zoom({ position: 'bottomleft' }).addTo(state.map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
    }).addTo(state.map);

    const bounds = [[OLAVARRIA_BOUNDS.minLat, OLAVARRIA_BOUNDS.minLng],
                    [OLAVARRIA_BOUNDS.maxLat, OLAVARRIA_BOUNDS.maxLng]];
    L.rectangle(bounds, { color: '#cbd5e1', weight: 2, fillOpacity: 0.05, dashArray: '5, 5' }).addTo(state.map);

    // Los reclamos aprobados van agrupados (clustering) para que no se amontonen
    // en el mapa cuando hay muchos cerca. Ver leaflet.markercluster en index.html.
   state.clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 2,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function(cluster) {
        const childCount = cluster.getChildCount();
        const adhesions = Math.max(...cluster.getAllChildMarkers().map(m => {
            const data = m.options.claimData;
            return data ? (data.adhesions || 0) : 0;
        }));
        const priority = adhesions >= 20 ? 'urgente' : (adhesions >= 10 ? 'prioritario' : 'normal');
        const coneImg = priority === 'urgente' ? 'cono-rojo.png' : (priority === 'prioritario' ? 'cono-naranja.png' : 'cono-amarillo.png');
        
        return L.divIcon({
            html: `
                <div style="position: relative; width: 42px; height: 42px;">
                    <img src="${coneImg}" style="width: 42px; height: 42px; filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));">
                    <div style="position: absolute; bottom: -8px; right: -8px; background: #1e293b; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${childCount}</div>
                </div>
            `,
            iconSize: [42, 42],
            className: ''
        });
    }
});
    state.map.addLayer(state.clusterGroup);

    state.map.on('click', (e) => {
        // Suspendido mientras el admin está reubicando un reclamo existente
        // (ver startAdminLocationPick) — si no, este mismo click abriría además
        // el flujo de "crear reclamo nuevo acá".
        if (state.suspendMapClickToCreate) return;

        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        if (!isWithinOlavarria(lat, lng)) {
            alert('⚠️ Solo puedes crear reclamos dentro del partido de Olavarría');
            return;
        }

        state.mapClickLocation = { lat, lng };
        showMapClickModal(lat, lng);
    });

    renderMapPins();
}

// Deja que el admin corrija la ubicación de un reclamo existente tocando el
// mapa (para cuando el vecino le erró al pin pero puso bien la dirección en
// la descripción). Reutiliza el overlay/banner de "señalar en mapa" ya
// existente; solo guarda la nueva ubicación en state.adminMoveLocation, no
// escribe nada en Firestore todavía — eso lo hace saveEditBtn al guardar.
function startAdminLocationPick(onPicked) {
    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    const bannerText = banner.querySelector('span');
    const originalBannerText = bannerText.textContent;
    const detailPanel = document.getElementById('detailPanel');

    detailPanel.classList.remove('visible');
    bannerText.textContent = '👆 Tocá el mapa donde va realmente este reclamo';
    overlay.classList.remove('hidden');
    banner.classList.remove('hidden');
    state.suspendMapClickToCreate = true;

    const cleanup = () => {
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        bannerText.textContent = originalBannerText;
        state.suspendMapClickToCreate = false;
        detailPanel.classList.add('visible');
    };

    document.getElementById('cancelMapClickBanner').onclick = () => {
        cleanup();
    };

    state.map.once('click', (e) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        if (!isWithinOlavarria(lat, lng)) {
            alert('⚠️ Solo puedes ubicar reclamos dentro del partido de Olavarría');
            cleanup();
            return;
        }

        state.adminMoveLocation = { lat, lng };
        cleanup();
        onPicked();
    });
}

function showMapClickModal(lat, lng) {
    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    
    state.mapClickLocation = { lat, lng };
    
    // Agregar marcador visual temporal en el mapa
    if (window.mapClickMarker) {
        state.map.removeLayer(window.mapClickMarker);
    }
    
    const icon = L.divIcon({
        html: `<div style="width:20px; height:20px; border-radius:50%; background:#10b981; border:3px solid white; box-shadow:0 0 8px rgba(16,185,129,0.6);"></div>`,
        iconSize: [26, 26],
        className: ''
    });
    
    window.mapClickMarker = L.marker([lat, lng], { icon }).addTo(state.map);
    
    overlay.classList.remove('hidden');
    banner.classList.remove('hidden');

    const confirmAction = () => {
        state.currentLocation = { lat, lng };
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        if (window.mapClickMarker) {
            state.map.removeLayer(window.mapClickMarker);
            window.mapClickMarker = null;
        }
        document.getElementById('claimModal').classList.remove('hidden');
        showLocationDisplay();
    };

    document.getElementById('cancelMapClickBanner').onclick = () => {
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        if (window.mapClickMarker) {
            state.map.removeLayer(window.mapClickMarker);
            window.mapClickMarker = null;
        }
        document.getElementById('claimModal').classList.remove('hidden');
        state.mapClickLocation = null;
    };

    state.map.once('click', (e) => {
        const newLat = e.latlng.lat;
        const newLng = e.latlng.lng;

        if (!isWithinOlavarria(newLat, newLng)) {
            alert('⚠️ Solo puedes crear reclamos dentro del partido de Olavarría');
            return;
        }

        state.mapClickLocation = { lat: newLat, lng: newLng };
        confirmAction();
    });
}

function openNewClaimFlow() {
    state.currentLocation = null;
    state.selectedCategory = null;
    state.currentPhoto = null;
    openClaimModal();
}

function setupApplicationEvents() {
    document.getElementById('newClaimBtn').addEventListener('click', openNewClaimFlow);

    document.getElementById('retryLoadBtn')?.addEventListener('click', async () => {
        await loadPublicClaims();
        renderMapPins();
        renderPublicClaimsList();
    });

    document.getElementById('closeModal').addEventListener('click', requestCloseClaimModal);
    document.getElementById('closeModalBtn').addEventListener('click', requestCloseClaimModal);
    document.getElementById('successCloseBtn').addEventListener('click', closeClaimModal);
    document.getElementById('closeDetail').addEventListener('click', () => {
        document.getElementById('detailPanel').classList.remove('visible');
    });

    const trigger = document.getElementById('recentClaimsTrigger');
    const popup = document.getElementById('recentClaimsPopup');
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.toggle('hidden');
    });
    document.getElementById('closeRecentPopup').addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.add('hidden');
    });

    document.getElementById('categoryFilterBar').addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;

        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        state.activeCategoryFilter = btn.dataset.cat;
        renderMapPins();
        renderPublicClaimsList();
    });

    const categoriesOptions = document.querySelectorAll('#categoryGrid .category-option');
    categoriesOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            categoriesOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            state.selectedCategory = opt.getAttribute('data-value');
        });
    });

    document.getElementById('useGPS').addEventListener('click', triggerGPSCapture);
    document.getElementById('useMapClick').addEventListener('click', openMapClickModal);
    document.getElementById('photoDropZone').addEventListener('click', () => {
        document.getElementById('claimPhoto').click();
    });
    document.getElementById('claimPhoto').addEventListener('change', processPhotoFile);
    document.getElementById('removePhoto').addEventListener('click', clearPhotoEvidencia);
    document.getElementById('submitBtn').addEventListener('click', executeSubmitForm);

    document.getElementById('toggleDashBtn').addEventListener('click', () => {
        document.getElementById('adminPanel').classList.remove('hidden');
        syncAdminDashboard();
    });
    document.getElementById('closeDashBtn').addEventListener('click', () => {
        document.getElementById('adminPanel').classList.add('hidden');
        setTimeout(() => state.map.invalidateSize(), 200);
    });
    document.getElementById('exitSessionBtn').addEventListener('click', handleAdminLogout);

    document.querySelectorAll('.admin-nav .nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.admin-nav .nav-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderAdminViewCards(e.target.dataset.section);
        });
    });

    document.getElementById('closeAdhesionModal').addEventListener('click', () => {
        document.getElementById('adhesionModal').classList.add('hidden');
    });
    document.getElementById('cancelAdhesion').addEventListener('click', () => {
        document.getElementById('adhesionModal').classList.add('hidden');
    });

    document.getElementById('adminLoginBtn').addEventListener('click', handleAdminLogin);
    document.getElementById('cancelAdminLogin').addEventListener('click', () => {
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminLoginError').style.display = 'none';
    });
    document.getElementById('closeAdminLogin').addEventListener('click', () => {
        document.getElementById('adminLoginModal').classList.add('hidden');
        document.getElementById('adminLoginError').style.display = 'none';
    });
    document.getElementById('adminPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAdminLogin();
    });
}

function openClaimModal() {
    const modal = document.getElementById('claimModal');
    const hasLocation = state.currentLocation !== null;
    resetFormState(hasLocation);
    modal.classList.remove('hidden');

    if (state.currentLocation) {
        showLocationDisplay();
    }
}

function showLocationDisplay() {
    const locDisplay = document.getElementById('locationDisplay');
    if (state.currentLocation) {
        locDisplay.style.display = 'block';
        locDisplay.textContent = `✅ Ubicación: ${state.currentLocation.lat.toFixed(4)}, ${state.currentLocation.lng.toFixed(4)}`;
    }
}

function openMapClickModal() {
    const modal = document.getElementById('claimModal');
    modal.classList.add('hidden');

    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    
    overlay.classList.remove('hidden');
    banner.classList.remove('hidden');

    document.getElementById('cancelMapClickBanner').onclick = () => {
        overlay.classList.add('hidden');
        banner.classList.add('hidden');
        modal.classList.remove('hidden');
        state.mapClickLocation = null;
    };
}

function formHasContent() {
    return !!(
        document.getElementById('claimTitle').value.trim() ||
        document.getElementById('claimDescription').value.trim() ||
        document.getElementById('claimName').value.trim() ||
        document.getElementById('claimPhone').value.trim() ||
        document.getElementById('claimAddress').value.trim() ||
        state.selectedCategory ||
        state.currentPhoto ||
        state.currentLocation
    );
}

function requestCloseClaimModal() {
    const successVisible = document.getElementById('formSuccessView').style.display === 'block';
    if (!successVisible && formHasContent()) {
        if (!confirm('¿Descartar este reclamo? Vas a perder lo que escribiste.')) return;
    }
    closeClaimModal();
}

function closeClaimModal() {
    document.getElementById('claimModal').classList.add('hidden');
    const indicator = document.getElementById('mapClickIndicator');
    if (indicator) indicator.remove();
    state.currentLocation = null;
    state.selectedCategory = null;
    state.currentPhoto = null;
    document.getElementById('locationDisplay').style.display = 'none';
    const overlay = document.getElementById('mapClickOverlay');
    const banner = document.getElementById('mapClickBanner');
    overlay.classList.add('hidden');
    banner.classList.add('hidden');
    if (window.mapClickMarker) {
        state.map.removeLayer(window.mapClickMarker);
        window.mapClickMarker = null;
    }
    resetFormState(false);
}

function resetFormState(preserveLocation = false) {
    document.getElementById('claimTitle').value = '';
    document.getElementById('claimName').value = '';
    document.getElementById('claimPhone').value = '';
    document.getElementById('claimAddress').value = '';
    document.getElementById('claimDescription').value = '';
    document.getElementById('locationDisplay').style.display = 'none';

    document.querySelectorAll('#categoryGrid .category-option').forEach(o => o.classList.remove('selected'));
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoDropZone').style.display = 'block';

    // Volvemos a mostrar el formulario (por si veníamos de la pantalla de éxito)
    document.getElementById('claimFormBody').style.display = '';
    document.getElementById('formSuccessView').style.display = 'none';
    document.getElementById('formMessage').style.display = 'none';
    document.getElementById('submitBtn').style.display = '';
    document.getElementById('closeModalBtn').style.display = '';
    document.getElementById('successCloseBtn').style.display = 'none';

    state.selectedCategory = null;
    if (!preserveLocation) state.currentLocation = null;
    state.currentPhoto = null;
}

function triggerGPSCapture() {
    if (!navigator.geolocation) {
        flashErrorMessage('Tu navegador no soporta GPS.');
        return;
    }

    document.getElementById('useGPS').disabled = true;
    document.getElementById('useGPS').textContent = '📍 Buscando ubicación...';

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            if (!isWithinOlavarria(lat, lng)) {
                flashErrorMessage('GPS fuera del partido de Olavarría. Ingresa la dirección manualmente.');
                document.getElementById('useGPS').disabled = false;
                document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
                return;
            }

            state.currentLocation = { lat, lng };
            const locDisplay = document.getElementById('locationDisplay');
            locDisplay.style.display = 'block';
            locDisplay.textContent = `✅ Ubicación capturada: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

            document.getElementById('useGPS').disabled = false;
            document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
        },
        (err) => {
            flashErrorMessage(getGPSErrorMessage(err));
            if (err.code === 1) highlightMapClickAlternative();
            document.getElementById('useGPS').disabled = false;
            document.getElementById('useGPS').textContent = '📍 Capturar por GPS';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

function getGPSErrorMessage(err) {
    // err.code === 1 (PERMISSION_DENIED): el navegador no tiene ninguna API para
    // volver a mostrar el diálogo nativo de permiso una vez que el usuario lo negó
    // (restricción de seguridad del browser/SO) — lo único que podemos hacer es
    // indicarle dónde reactivarlo a mano.
    if (err.code === 1) {
        return getLocationPermissionDeniedMessage();
    }
    if (err.code === 2) {
        return '⚠️ No se pudo determinar tu ubicación (GPS/ubicación del dispositivo apagado). Activalo o usá "📍 Señalar en mapa".';
    }
    if (err.code === 3) {
        return '⚠️ Se agotó el tiempo esperando el GPS. Probá de nuevo o usá "📍 Señalar en mapa".';
    }
    return `GPS error: ${err.message}`;
}

// Instrucciones aproximadas por navegador/SO para reactivar el permiso de
// ubicación a mano. La detección por user agent no es perfecta, pero alcanza
// para diferenciar los dos casos más comunes; para cualquier otro caso damos
// una instrucción genérica.
function getLocationPermissionDeniedMessage() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const isSafariIOS = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    const isAndroidChrome = /Android/.test(ua) && /Chrome/.test(ua);

    let howTo = 'Revisá los permisos de ubicación de este sitio en la configuración de tu navegador y habilitalos.';
    if (isSafariIOS) {
        howTo = 'Activalo en Ajustes del iPhone → Safari → Ubicación → "Preguntar" (si entraste desde un ícono agregado a la pantalla de inicio: Ajustes → Privacidad y seguridad → Localización → Safari).';
    } else if (isAndroidChrome) {
        howTo = 'Tocá el ícono de candado/info junto a la dirección del sitio → Permisos → Ubicación → Permitir.';
    }

    return `⚠️ El navegador tiene bloqueado el permiso de ubicación para este sitio. ${howTo} Mientras tanto, usá el botón "📍 Señalar en mapa" de al lado para marcar la ubicación a mano.`;
}

// Llama la atención sobre el botón "Señalar en mapa" cuando el GPS quedó
// bloqueado, para que la alternativa sea obvia y la persona no se quede
// trabada esperando un permiso que ya sabemos que no va a volver a aparecer.
function highlightMapClickAlternative() {
    const btn = document.getElementById('useMapClick');
    if (!btn) return;
    btn.classList.add('btn-attention-pulse');
    setTimeout(() => btn.classList.remove('btn-attention-pulse'), 2500);
}

// ---------------------------------------------------------------------------
// FOTOS — aceptamos cualquier tamaño real de foto de celular. La comprimimos
// nosotros en el navegador (canvas) antes de guardarla, así siempre entra en
// el límite de 1MB por documento que tiene Firestore. Nunca bloqueamos al
// usuario por el peso del archivo original.
// ---------------------------------------------------------------------------

function processPhotoFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Validar que sea imagen, no video
    if (!file.type.startsWith('image/')) {
        flashErrorMessage('Solo se aceptan imágenes. Por favor, sube una foto.');
        return;
    }

    // Validar tamaño máximo 5MB
    if (file.size > 5 * 1024 * 1024) {
        flashErrorMessage('La imagen pesa demasiado para subirla desde tu dispositivo');
        return;
    }

    const dropIcon = document.getElementById('photoDropIcon');
    const dropLabel = document.getElementById('photoDropLabel');
    const originalIcon = dropIcon.textContent;
    const originalLabel = dropLabel.textContent;

    dropIcon.textContent = '⏳';
    dropLabel.textContent = 'Optimizando imagen...';

    compressImage(file)
        .then((dataUrl) => {
            state.currentPhoto = dataUrl;
            document.getElementById('photoImg').src = state.currentPhoto;
            dropIcon.textContent = originalIcon;
            dropLabel.textContent = originalLabel;
            document.getElementById('photoDropZone').style.display = 'none';
            document.getElementById('photoPreview').style.display = 'block';
        })
        .catch((error) => {
            console.error('Error procesando la imagen:', error);
            dropIcon.textContent = originalIcon;
            dropLabel.textContent = originalLabel;
            flashErrorMessage('No se pudo procesar esa imagen. Probá con otra foto.');
        });
}

function compressImage(file, maxWidth = 1600) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > maxWidth) {
                    height = Math.round(height * (maxWidth / width));
                    width = maxWidth;
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                let quality = 0.75;
                let dataUrl = canvas.toDataURL('image/jpeg', quality);

                // Firestore tiene un límite de 1MB por documento. Bajamos calidad
                // hasta que la foto entre cómoda, sin bloquear nunca al usuario
                // por el tamaño del archivo original (puede ser 12MB de un iPhone,
                // no importa: acá la reducimos igual).
                while (dataUrl.length > 700 * 1024 && quality > 0.3) {
                    quality -= 0.1;
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                }

                resolve(dataUrl);
            };
            img.onerror = () => reject(new Error('No se pudo leer la imagen'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
    });
}

// Devuelve { photo, error }. Cachea resultados exitosos (incluido "no tiene foto" = null).
// Los errores NO se cachean (para poder reintentar) y las llamadas concurrentes para el
// mismo fbId comparten la misma promesa en vuelo, así un click rápido en "Ver detalles"
// justo después de abrir el popup nunca dispara una segunda descarga.
async function fetchClaimPhoto(fbId, collectionName) {
    if (Object.prototype.hasOwnProperty.call(state.photoCache, fbId)) {
        return { photo: state.photoCache[fbId], error: false };
    }
    if (state.photoFetchPromises[fbId]) {
        return state.photoFetchPromises[fbId];
    }

    const promise = (async () => {
        try {
            const { doc, getDoc } = window.dbMethods;
            const mediaRef = doc(window.db, collectionName, fbId, 'media', 'foto');
            const snap = await getDoc(mediaRef);
            const photo = snap.exists() ? (snap.data().photo || null) : null;
            state.photoCache[fbId] = photo;
            return { photo, error: false };
        } catch (error) {
            console.error('Error obteniendo la foto del reclamo:', error);
            return { photo: null, error: true };
        } finally {
            delete state.photoFetchPromises[fbId];
        }
    })();

    state.photoFetchPromises[fbId] = promise;
    return promise;
}

// Carga la foto de un reclamo dentro de un contenedor de POPUP identificado por
// [data-fbid]. Se dispara al abrir el popup (no antes). Si el usuario ya cerró el
// popup o abrió otro reclamo cuando la respuesta llega, el contenedor ya no está en
// el DOM (Leaflet lo saca al cerrar) y la actualización se descarta sola.
function loadPopupPhoto(claim, collectionName) {
    const fbId = claim._fbId;
    const selector = `.popup-img-placeholder[data-fbid="${fbId}"]`;
    if (!document.querySelector(selector)) return;

    fetchClaimPhoto(fbId, collectionName).then(({ photo, error }) => {
        const el = document.querySelector(selector);
        if (!el) return; // el popup ya no está abierto / cambió de reclamo

        if (photo) {
            el.outerHTML = `<div class="popup-img-container"><img src="${photo}" class="popup-mini-img" alt="Foto del reclamo"></div>`;
        } else if (error) {
            el.classList.remove('popup-img-loading');
            el.innerHTML = `<button type="button" class="popup-photo-retry" onclick="retryPopupPhoto('${fbId}', '${collectionName}')">⚠️ No se pudo cargar. Reintentar</button>`;
        } else {
            el.remove(); // ya consultamos: no tiene foto
        }
    });
}

window.retryPopupPhoto = function (fbId, collectionName) {
    const selector = `.popup-img-placeholder[data-fbid="${fbId}"]`;
    const el = document.querySelector(selector);
    if (!el) return;
    el.classList.add('popup-img-loading');
    el.innerHTML = '<div class="popup-img-spinner">⏳</div>';
    loadPopupPhoto({ _fbId: fbId }, collectionName);
};

window.retryDetailPhoto = function (fbId, collectionName) {
    const container = document.getElementById('detailPhotoContainer');
    if (!container || container.dataset.fbid !== fbId) return;
    container.outerHTML = `<div class="detail-card" id="detailPhotoContainer" data-fbid="${fbId}">
        <div style="padding:30px; text-align:center; color:#64748b; font-size:12px; font-weight:600;">⏳ Cargando imagen...</div>
    </div>`;
    fetchClaimPhoto(fbId, collectionName).then(({ photo, error }) => {
        const el = document.getElementById('detailPhotoContainer');
        if (!el || el.dataset.fbid !== fbId) return;
        if (photo) {
            el.outerHTML = `<div class="detail-card"><img src="${photo}" class="detail-img" alt="Foto del reclamo"></div>`;
        } else if (error) {
            el.outerHTML = `
                <div class="detail-card detail-photo-error" id="detailPhotoContainer" data-fbid="${fbId}">
                    <div style="padding:20px; text-align:center; color:#991b1b; font-size:12px; font-weight:600;">
                        ⚠️ No se pudo cargar la imagen.
                        <button type="button" class="popup-photo-retry" onclick="retryDetailPhoto('${fbId}', '${collectionName}')">Reintentar</button>
                    </div>
                </div>`;
        } else {
            el.remove();
        }
    });
};

function clearPhotoEvidencia() {
    state.currentPhoto = null;
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoDropZone').style.display = 'block';
    document.getElementById('claimPhoto').value = '';
}


// ---------------------------------------------------------------------------
// CREAR RECLAMO
// ---------------------------------------------------------------------------

function isPlausiblePhone(phone) {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 13;
}

async function executeSubmitForm() {
    const title = document.getElementById('claimTitle').value.trim();
    const name = document.getElementById('claimName').value.trim();
    const phone = document.getElementById('claimPhone').value.trim();
    const address = document.getElementById('claimAddress').value.trim();
    const category = state.selectedCategory;
    const location = state.currentLocation;

    if (!title) return flashErrorMessage('Ingresa el título del reclamo');
    if (!category) return flashErrorMessage('Selecciona una categoría');
    if (!location) return flashErrorMessage('⚠️ Debes seleccionar ubicación: Usa GPS o señala en el mapa');
    if (!name) return flashErrorMessage('Ingresa tu nombre');
    if (phone && !isPlausiblePhone(phone)) return flashErrorMessage('Ingresa un teléfono válido (con o sin código de área)');

    const claimId = 'OLV-' + new Date().getFullYear() + '-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');

    // 🆕 doc principal SIN "photo" — solo el flag liviano hasPhoto
    const claimData = {
        id: Date.now(),
        claimId: claimId,
        name: name,
        email: '',
        title: title,
        category: category,
        urgency: 'normal',
        address: address || '',
        description: document.getElementById('claimDescription').value.trim(),
        lat: location.lat,
        lng: location.lng,
        hasPhoto: !!state.currentPhoto, // 🆕
        phone: phone,
        status: 'pending',
        adhesions: 0,
        createdAt: new Date().toISOString()
    };

    const btn = document.getElementById('submitBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
        const { collection, addDoc, doc, setDoc } = window.dbMethods;
        const docRef = await addDoc(collection(window.db, "reclamos"), claimData);
        claimData._fbId = docRef.id;

        // 🆕 si hay foto, se guarda aparte en la subcolección
        if (state.currentPhoto) {
            try {
                await setDoc(doc(window.db, "reclamos", docRef.id, "media", "foto"), {
                    photo: state.currentPhoto
                });
                state.photoCache[docRef.id] = state.currentPhoto; // ya la tenemos, no hace falta re-pedirla
            } catch (photoError) {
                console.error('Error guardando la foto:', photoError);
                // No bloqueamos el reclamo por esto — el reclamo ya se creó bien
            }
        }

        if (state.isAdmin) {
            state.adminClaims.push(claimData);
            syncAdminDashboard();
        } else {
            state.mySessionPendingClaims.push(claimData);
            saveClaimToLocalTracking(claimData);
        }

        renderMapPins();

        document.getElementById('claimFormBody').style.display = 'none';
        document.getElementById('formSuccessView').style.display = 'block';
        document.getElementById('submitBtn').style.display = 'none';
        document.getElementById('closeModalBtn').style.display = 'none';
        document.getElementById('successCloseBtn').style.display = 'inline-block';

        state.currentLocation = null;
        state.selectedCategory = null;
        state.currentPhoto = null;
    } catch (error) {
        console.error('Error al guardar:', error);
        const msg = navigator.onLine
            ? 'Error al guardar. Intenta nuevamente.'
            : 'Sin conexión a internet. Revisá tu conexión e intenta de nuevo.';
        flashErrorMessage(msg);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Enviar Reporte';
    }
}

function flashErrorMessage(msg) {
    const el = document.getElementById('formMessage');
    el.textContent = msg;
    el.style.background = '#fee2e2';
    el.style.color = '#991b1b';
    el.style.display = 'block';
    return false;
}

function flashSuccessMessage(msg) {
    const el = document.getElementById('formMessage');
    el.textContent = msg;
    el.style.background = '#dcfce7';
    el.style.color = '#15803d';
    el.style.display = 'block';
}

function calculatePriority(adhesions) {
    if (adhesions >= 20) return 'urgente';
    if (adhesions >= 10) return 'prioritario';
    return 'normal';
}

function getPriorityLabel(adhesions) {
    if (adhesions >= 20) return 'Urgente';
    if (adhesions >= 10) return 'Prioritario';
    return 'Normal';
}

function getPrioritySvg(adhesions) {
    if (adhesions >= 20) {
        return '<img src="cono-rojo.png" class="priority-icon" alt="Urgente">';
    }
    if (adhesions >= 10) {
        return '<img src="cono-naranja.png" class="priority-icon" alt="Prioritario">';
    }
    return '<img src="cono-amarillo.png" class="priority-icon" alt="Normal">';
}

// ---------------------------------------------------------------------------
// ADHESIÓN
// ---------------------------------------------------------------------------

const ADHESION_STORAGE_KEY = 'mp_adhered_claims';

function getAdheredClaimIds() {
    try {
        return JSON.parse(localStorage.getItem(ADHESION_STORAGE_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function hasAdheredTo(fbId) {
    return getAdheredClaimIds().includes(fbId);
}

function markClaimAdhered(fbId) {
    const ids = getAdheredClaimIds();
    if (!ids.includes(fbId)) {
        ids.push(fbId);
        try { localStorage.setItem(ADHESION_STORAGE_KEY, JSON.stringify(ids)); } catch (e) { /* localStorage lleno/deshabilitado, no bloqueamos la adhesión por esto */ }
    }
}

async function addAdhesion(claimId) {
    if (hasAdheredTo(claimId)) {
        alert('Ya adheriste a este reclamo desde este dispositivo. ¡Gracias!');
        return;
    }

    document.getElementById('detailPanel').classList.remove('visible');

    const modal = document.getElementById('adhesionModal');
    modal.classList.remove('hidden');

    const submitBtn = document.getElementById('submitAdhesion');

    const handleSubmit = async () => {
        const name = document.getElementById('adhesionName').value.trim();
        if (!name) {
            alert('Ingresa tu nombre para adherir');
            return;
        }

        const claim = state.claims.find(c => c._fbId === claimId);
        if (!claim) return;

        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';

        try {
            const newCount = (claim.adhesions || 0) + 1;
            const { doc, updateDoc } = window.dbMethods;
            const docRef = doc(window.db, "reclamos_publicos", claimId);
            await updateDoc(docRef, { adhesions: newCount });
            claim.adhesions = newCount;
            markClaimAdhered(claimId);

            document.getElementById('adhesionName').value = '';
            modal.classList.add('hidden');

            renderPublicClaimsList();
            renderMapPins();
            globalOpenDetailWindow(claimId);

            alert('✅ ¡Gracias por tu adhesión!');
        } catch (error) {
            console.error('Error al adherir:', error);
            alert('Error al guardar tu adhesión');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Adherir';
        }
    };

    submitBtn.onclick = handleSubmit;
}

// ---------------------------------------------------------------------------
// MAPA — aprobados agrupados (clustering) + pendientes en gris
// ---------------------------------------------------------------------------

function renderMapPins() {
    if (!state.map || !state.clusterGroup) return;

    state.clusterGroup.clearLayers();
    state.markers.forEach(m => state.map.removeLayer(m));
    state.markers = [];

    // --- Aprobados (clusterizados) ---
    let filtered = state.claims.filter(c => c.status === 'approved');

    if (state.activeCategoryFilter !== 'all') {
        filtered = filtered.filter(c => c.category === state.activeCategoryFilter);
    }

    filtered.sort((a, b) => {
        const aPrio = calculatePriority(a.adhesions || 0);
        const bPrio = calculatePriority(b.adhesions || 0);
        const priorityOrder = { urgente: 0, prioritario: 1, normal: 2 };
        if (priorityOrder[aPrio] !== priorityOrder[bPrio]) {
            return priorityOrder[aPrio] - priorityOrder[bPrio];
        }
        return (b.adhesions || 0) - (a.adhesions || 0);
    });

    filtered.forEach(claim => {
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const prioritySvg = getPrioritySvg(claim.adhesions || 0);
        const icon = L.divIcon({
            html: `<div style="font-size:24px; filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));">${prioritySvg}</div>`,
            iconSize: [32, 32],
            className: ''
        });

const marker = L.marker([claim.lat, claim.lng], { icon, claimData: claim });

        // No se descarga ninguna imagen acá (esto corre para TODOS los pines al
        // renderizar el mapa). Si el reclamo es formato nuevo (hasPhoto), solo
        // dejamos un placeholder — la foto real se pide recién cuando se abre
        // el popup (ver marker.on('popupopen', ...) más abajo).
        const isOldFormat = Object.prototype.hasOwnProperty.call(claim, 'photo');
        const needsLazyPhoto = !isOldFormat && claim.hasPhoto;
        const imgHTML = isOldFormat && claim.photo
            ? `<div class="popup-img-container"><img src="${claim.photo}" class="popup-mini-img" alt="Foto del reclamo"></div>`
            : (needsLazyPhoto
                ? `<div class="popup-img-container popup-img-placeholder popup-img-loading" data-fbid="${claim._fbId}"><div class="popup-img-spinner">⏳</div></div>`
                : '');

        const locText = escapeHtml(claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}`);
        const popupHTML = `
            <div class="custom-popup">
                ${imgHTML}
                <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="popup-meta">${locText}</div>
                <div class="popup-time">${priorityLabel}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Ver detalles</button>
            </div>
        `;

        marker.bindPopup(popupHTML);
        if (needsLazyPhoto) {
            marker.on('popupopen', () => loadPopupPhoto(claim, 'reclamos_publicos'));
        }
        state.clusterGroup.addLayer(marker);
    });

    // --- Pendientes en gris (sin clusterizar, son pocos) ---
    // Admin: ve TODOS los pendientes reales (vienen de Firestore, persistentes).
    // Vecino sin sesión admin: ve SOLO lo que él mismo cargó en esta pestaña.
    let pendingToShow = state.isAdmin
        ? state.adminClaims.filter(c => c.status === 'pending')
        : state.mySessionPendingClaims;

    if (state.activeCategoryFilter !== 'all') {
        pendingToShow = pendingToShow.filter(c => c.category === state.activeCategoryFilter);
    }

    pendingToShow.forEach(claim => {
        const icon = L.divIcon({
            html: `<div style="width:18px; height:18px; border-radius:50%; background:#94a3b8; border:2px solid #fff; box-shadow:0 0 4px rgba(0,0,0,0.4);"></div>`,
            iconSize: [22, 22],
            className: ''
        });

        const marker = L.marker([claim.lat, claim.lng], { icon, opacity: 0.85 }).addTo(state.map);

        const isOldFormat = Object.prototype.hasOwnProperty.call(claim, 'photo');
        const needsLazyPhoto = state.isAdmin && !isOldFormat && claim.hasPhoto;
        const imgHTML = state.isAdmin && isOldFormat && claim.photo
            ? `<div class="popup-img-container"><img src="${claim.photo}" class="popup-mini-img" alt="Foto del reclamo"></div>`
            : (needsLazyPhoto
                ? `<div class="popup-img-container popup-img-placeholder popup-img-loading" data-fbid="${claim._fbId}"><div class="popup-img-spinner">⏳</div></div>`
                : '');

        const popupHTML = state.isAdmin
            ? `
                <div class="custom-popup">
                    ${imgHTML}
                    <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                    <div class="popup-meta">⏳ Pendiente de revisión</div>
                    <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Inspeccionar</button>
                </div>
            `
            : `
                <div class="custom-popup">
                    <div class="popup-title">${escapeHtml(claim.title || claim.claimId)}</div>
                    <div class="popup-meta">⏳ Tu reclamo — pendiente de revisión</div>
                </div>
            `;

        marker.bindPopup(popupHTML);
        if (needsLazyPhoto) {
            marker.on('popupopen', () => loadPopupPhoto(claim, 'reclamos'));
        }
        state.markers.push(marker);
    });
}

function globalOpenDetailWindow(fbId) {
    const claim = findClaimById(fbId);
    if (!claim) return;

    const priorityLabel = getPriorityLabel(claim.adhesions || 0);
    const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };

   let html = '';

    // 🆕 Detección de formato: reclamos viejos tienen "photo" inline en el doc.
// Reclamos nuevos NO tienen ese campo, tienen "hasPhoto" + subcolección media/foto.
const isOldFormat = Object.prototype.hasOwnProperty.call(claim, 'photo');
const cacheHasEntry = Object.prototype.hasOwnProperty.call(state.photoCache, fbId);

if (isOldFormat) {
    // Compatibilidad con reclamos antiguos: la foto ya viene inline, se muestra directo.
    if (claim.photo) {
        html += `<div class="detail-card"><img src="${claim.photo}" class="detail-img"></div>`;
    }
} else if (claim.hasPhoto) {
    if (cacheHasEntry && state.photoCache[fbId]) {
        html += `<div class="detail-card"><img src="${state.photoCache[fbId]}" class="detail-img"></div>`;
    } else if (!cacheHasEntry) {
        html += `<div class="detail-card" id="detailPhotoContainer" data-fbid="${fbId}">
            <div style="padding:30px; text-align:center; color:#64748b; font-size:12px; font-weight:600;">⏳ Cargando imagen...</div>
        </div>`;
    }
    // si cacheHasEntry es true pero el valor es null, significa que ya consultamos
    // y no hay foto -> no mostramos nada, sin volver a pedir.
}

    // ID solo visible para admin
    if (state.isAdmin) {
        html += `
            <div class="detail-card">
                <div class="detail-label">ID</div>
                <div class="detail-value">${escapeHtml(claim.claimId)}</div>
            </div>
        `;
    }

    // Datos de contacto del vecino — solo admin, solo existen en la colección
    // privada "reclamos" (nunca llegan a reclamos_publicos).
    if (state.isAdmin && (claim.name || claim.phone)) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Datos de contacto</div>
                <div class="detail-value">${escapeHtml(claim.name || '—')}${claim.phone ? ' · ' + escapeHtml(claim.phone) : ' · sin teléfono'}</div>
            </div>
        `;
    }

    html += `
        <div class="detail-card">
            <div class="detail-label">Título</div>
            <div class="detail-value">${escapeHtml(claim.title || claim.claimId)}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Categoría</div>
            <div class="detail-value">${escapeHtml(cat.label)}</div>
        </div>
        <div class="detail-card">
            <div class="detail-label">Estado de Prioridad</div>
            <div class="detail-value"><span class="status-badge status-${calculatePriority(claim.adhesions || 0)}">${priorityLabel}</span></div>
        </div>
    `;

    // Coordenadas solo para admin
    if (state.isAdmin) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Ubicación Registrada (GPS)</div>
                <div class="detail-value">${claim.lat.toFixed(4)}, ${claim.lng.toFixed(4)}</div>
            </div>
        `;
    }

    if (claim.description) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Descripción</div>
                <div class="detail-value">${escapeHtml(claim.description)}</div>
            </div>
        `;
    }

    // Dirección siempre visible (si existe)
    if (claim.address) {
        html += `
            <div class="detail-card">
                <div class="detail-label">Dirección / Referencia</div>
                <div class="detail-value">${escapeHtml(claim.address)}</div>
            </div>
        `;
    }

    if (claim.status === 'approved' || claim.status === 'solved') {
        const alreadyAdhered = hasAdheredTo(claim._fbId);
        html += `
            <div class="adhesion-section">
                <div class="adhesion-count">
                    <div class="adhesion-number">${claim.adhesions || 0}</div>
                    <div class="adhesion-label">vecino${(claim.adhesions || 0) !== 1 ? 's' : ''} adhieren</div>
                </div>
                <button class="btn-adhesion" ${alreadyAdhered ? 'disabled' : ''} onclick="addAdhesion('${claim._fbId}')">${alreadyAdhered ? '✅ Ya adheriste' : 'Adherir'}</button>
            </div>
        `;

        const shareUrl = `${window.location.origin}${window.location.pathname}?claim=${claim.claimId}`;
        const shareTitle = escapeHtml(claim.title || claim.claimId);
        html += `
            <div class="detail-card">
                <div class="detail-label">Compartir</div>
                <div class="share-section">
                    <button class="share-btn share-whatsapp" onclick="shareClaimOn('whatsapp', '${shareTitle}', '${shareUrl}')" title="WhatsApp">📱</button>
                    <button class="share-btn share-facebook" onclick="shareClaimOn('facebook', '${shareTitle}', '${shareUrl}')" title="Facebook">f</button>
                    <button class="share-btn share-instagram" onclick="shareClaimOn('instagram', '${shareTitle}', '${shareUrl}')" title="Instagram">📷</button>
                    <button class="share-btn share-twitter" onclick="shareClaimOn('twitter', '${shareTitle}', '${shareUrl}')" title="X">𝕏</button>
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="detail-card" style="background:#f1f5f9;">
                <div class="detail-label">Estado</div>
                <div class="detail-value">⏳ Pendiente de revisión por un administrador</div>
            </div>
        `;
    }

    if (state.isAdmin) {
        // No mostramos "Aprobar" si ya está aprobado/solucionado, ni "Rechazar"
        // si ya está rechazado — antes aparecían siempre los dos, sin importar
        // el estado actual del reclamo.
        const showApprove = claim.status !== 'approved' && claim.status !== 'solved';
        const showReject = claim.status !== 'rejected';
        if (showApprove || showReject) {
            html += `<div class="detail-actions">`;
            if (showApprove) html += `<button class="btn-action btn-approve" onclick="dispatchStatus('${claim._fbId}', 'approved')">✅ Aprobar</button>`;
            if (showReject) html += `<button class="btn-action btn-reject" onclick="dispatchStatus('${claim._fbId}', 'rejected')">❌ Rechazar</button>`;
            html += `</div>`;
        }
        if (claim.status === 'approved') {
            html += `
                <div class="detail-actions">
                    <button class="btn-action" style="background:#8b5cf6; color:white;" onclick="dispatchStatus('${claim._fbId}', 'solved')">🛠️ Solucionado</button>
                </div>
            `;
        }
        // Borrado definitivo disponible en cualquier estado (antes solo existía
        // para 'approved' — los rechazados/pendientes quedaban acumulados para siempre).
        html += `
            <div class="detail-actions">
                <button class="btn-action btn-reject" onclick="deleteClaimFromDatabase('${claim._fbId}')">🗑️ Borrar definitivamente</button>
            </div>
        `;
    }
// Centrar mapa en el reclamo y resaltar
    if (state.map) {
        state.map.setView([claim.lat, claim.lng], 16);
        
        // Opcional: dimmar otros marcadores (efecto sutil)
        document.querySelectorAll('.leaflet-marker-icon').forEach(marker => {
            marker.style.opacity = '0.3';
        });
        
        // Encontrar y resaltar el marcador específico del reclamo actual
        setTimeout(() => {
            state.clusterGroup.eachLayer((layer) => {
                if (layer.options && layer.options.claimData && layer.options.claimData._fbId === fbId) {
                    layer.setOpacity(1);
                }
            });
            state.markers.forEach(marker => {
                if (marker.options && marker.options.claimData && marker.options.claimData._fbId === fbId) {
                    marker.setOpacity(1);
                }
            });
        }, 100);
    }
    // Admin puede editar en cualquier estado (antes solo se podía en 'pending', lo
    // que forzaba un rechazo+recreación para corregir un typo post-aprobación).
    if (state.isAdmin) {
        html += `
            <div style="text-align:center; padding:8px;">
                <button id="toggleEditModeBtn" style="background:#8b5cf6; color:white; border:none; padding:6px 12px; border-radius:6px; font-weight:600; font-size:11px; cursor:pointer;">✏️ Editar reclamo</button>
            </div>
        `;
    }
    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailPanel').classList.add('visible');
    // Setup para el botón de edición (admin, cualquier estado)
    if (state.isAdmin) {
        const toggleEditBtn = document.getElementById('toggleEditModeBtn');
        const editForm = document.getElementById('detailEditForm');
        const bodyDiv = document.getElementById('detailBody');

        document.getElementById('editClaimDescription').value = claim.description || '';
        document.getElementById('editClaimAddress').value = claim.address || '';
        document.getElementById('editClaimCategory').value = claim.category || 'otro';

        state.adminMoveLocation = null; // reset: no arrastramos una ubicación elegida en otro reclamo
        const editLocationDisplay = document.getElementById('editLocationDisplay');
        const refreshEditLocationDisplay = () => {
            const loc = state.adminMoveLocation || { lat: claim.lat, lng: claim.lng };
            editLocationDisplay.textContent = state.adminMoveLocation
                ? `📍 Nueva ubicación (sin guardar): ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`
                : `📍 Ubicación actual: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
        };
        refreshEditLocationDisplay();

        // .onclick en vez de addEventListener: esto REEMPLAZA el handler anterior en
        // vez de apilarlo. #editMoveLocationBtn/#saveEditBtn/#cancelEditBtn viven en
        // #detailEditForm, un <div> estático que nunca se recrea entre reclamos — con
        // addEventListener, abrir varios reclamos en la misma sesión de admin dejaba
        // un listener por cada uno apilado, y "Guardar" los disparaba a todos juntos,
        // pisando el description/address/category/lat/lng de reclamos ajenos con el
        // contenido del formulario actual. Esto causó corrupción real de datos (ver
        // diagnóstico del 26/8: reclamos con contenido mezclado entre sí).
        document.getElementById('editMoveLocationBtn').onclick = () => {
            startAdminLocationPick(refreshEditLocationDisplay);
        };

        toggleEditBtn.addEventListener('click', () => {
            const isHidden = editForm.style.display === 'none';
            editForm.style.display = isHidden ? 'block' : 'none';
            bodyDiv.style.display = isHidden ? 'none' : 'block';
            toggleEditBtn.textContent = isHidden ? '✕ Cerrar edición' : '✏️ Editar reclamo';
        });

        document.getElementById('saveEditBtn').onclick = async () => {
            const newDesc = document.getElementById('editClaimDescription').value.trim();
            const newAddr = document.getElementById('editClaimAddress').value.trim();
            const newCat = document.getElementById('editClaimCategory').value;
            const newLoc = state.adminMoveLocation; // null si no se tocó la ubicación

            const btn = document.getElementById('saveEditBtn');
            btn.disabled = true;
            btn.textContent = 'Guardando...';

            try {
                const { doc, updateDoc } = window.dbMethods;
                const updatePayload = { description: newDesc, address: newAddr, category: newCat };
                if (newLoc) {
                    updatePayload.lat = newLoc.lat;
                    updatePayload.lng = newLoc.lng;
                }

                await updateDoc(doc(window.db, "reclamos", fbId), updatePayload);

                // Si ya está publicado (approved/solved), la edición también tiene
                // que reflejarse en la copia pública — si no, el vecino ve datos viejos.
                if (claim.status === 'approved' || claim.status === 'solved') {
                    try {
                        await updateDoc(doc(window.db, "reclamos_publicos", fbId), updatePayload);
                    } catch (publicError) {
                        console.error('Error actualizando la copia pública:', publicError);
                    }
                }

                claim.description = newDesc;
                claim.address = newAddr;
                claim.category = newCat;
                if (newLoc) {
                    claim.lat = newLoc.lat;
                    claim.lng = newLoc.lng;
                }
                state.adminMoveLocation = null;

                editForm.style.display = 'none';
                bodyDiv.style.display = 'block';
                toggleEditBtn.textContent = '✏️ Editar reclamo';

                await loadPublicClaims();
                renderPublicClaimsList();
                renderMapPins();
                globalOpenDetailWindow(fbId);
                alert('✅ Reclamo actualizado');
            } catch (error) {
                console.error('Error al guardar edición:', error);
                alert('Error al guardar los cambios');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Guardar';
            }
        };

        document.getElementById('cancelEditBtn').onclick = () => {
            state.adminMoveLocation = null;
            editForm.style.display = 'none';
            bodyDiv.style.display = 'block';
            toggleEditBtn.textContent = '✏️ Editar reclamo';
        };
    }
       // Si la foto ya fue cargada por el popup (o por una apertura previa del detalle),
       // `cacheHasEntry` ya es true y esto ni se ejecuta — no hay una segunda descarga.
       // Si todavía está en vuelo (click muy rápido en "Ver detalles"), fetchClaimPhoto
       // reutiliza la misma promesa que disparó el popup en vez de pedirla de nuevo.
       if (!isOldFormat && claim.hasPhoto && !cacheHasEntry) {
     const collectionName = state.isAdmin ? 'reclamos' : 'reclamos_publicos';
       fetchClaimPhoto(fbId, collectionName).then(({ photo, error }) => {
        const container = document.getElementById('detailPhotoContainer');
        // Si el usuario ya cerró el detalle o abrió otro reclamo, no tocamos nada
        if (!container || container.dataset.fbid !== fbId) return;

        if (photo) {
            container.outerHTML = `<div class="detail-card"><img src="${photo}" class="detail-img" alt="Foto del reclamo"></div>`;
        } else if (error) {
            container.outerHTML = `
                <div class="detail-card detail-photo-error" id="detailPhotoContainer" data-fbid="${fbId}">
                    <div style="padding:20px; text-align:center; color:#991b1b; font-size:12px; font-weight:600;">
                        ⚠️ No se pudo cargar la imagen.
                        <button type="button" class="popup-photo-retry" onclick="retryDetailPhoto('${fbId}', '${collectionName}')">Reintentar</button>
                    </div>
                </div>`;
        } else {
            container.remove();
        }
    });
}
    state.map.closePopup();
    document.getElementById('recentClaimsPopup').classList.add('hidden');
}

function shareClaimOn(platform, title, url) {
    const msg = `${title}. Ayudanos adhiriendo a este reclamo ciudadano.`;
    let shareUrl = '';

    switch (platform) {
        case 'whatsapp':
            shareUrl = `https://wa.me/?text=${encodeURIComponent(msg + ' ' + url)}`;
            break;
        case 'facebook':
            shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
            break;
        case 'instagram':
            alert('Copia el link y comparte en Instagram: ' + url);
            return;
        case 'twitter':
            shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(msg)}&url=${encodeURIComponent(url)}`;
            break;
    }

    if (shareUrl) window.open(shareUrl, '_blank');
}

function renderPublicClaimsList() {
    let approved = state.claims.filter(c => c.status === 'approved');

    if (state.activeCategoryFilter !== 'all') {
        approved = approved.filter(c => c.category === state.activeCategoryFilter);
    }

    approved.sort((a, b) => {
        const aPrio = calculatePriority(a.adhesions || 0);
        const bPrio = calculatePriority(b.adhesions || 0);
        const priorityOrder = { urgente: 0, prioritario: 1, normal: 2 };
        if (priorityOrder[aPrio] !== priorityOrder[bPrio]) {
            return priorityOrder[aPrio] - priorityOrder[bPrio];
        }
        return (b.adhesions || 0) - (a.adhesions || 0);
    });

    document.getElementById('claimCounter').textContent = approved.length;

    const html = approved.map((claim) => {
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const locText = escapeHtml(claim.address || `${claim.lat?.toFixed(4)}, ${claim.lng?.toFixed(4)}` || 'Ubicación registrada');
        return `
            <div class="claim-item" onclick="globalOpenDetailWindow('${claim._fbId}')">
                <div class="claim-item-header">
                    <span class="claim-item-id">${escapeHtml(claim.claimId)}</span>
                    <span class="claim-item-status">${priorityLabel}</span>
                </div>
                <div class="claim-item-name">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="claim-item-desc">${locText}...</div>
            </div>
        `;
    }).join('');
    document.getElementById('claimsList').innerHTML = html || '<div style="padding:16px; font-size:11px; color:#64748b; text-align:center; font-weight:600;">Sin reportes para esta sección.</div>';
}

// ---------------------------------------------------------------------------
// ACCIONES ADMIN
// ---------------------------------------------------------------------------

async function dispatchStatus(fbId, newStatus) {
    const claim = state.adminClaims.find(c => c._fbId === fbId);
    if (!claim) return;

    try {
        const {
            doc,
            updateDoc,
            setDoc,
            deleteDoc,
            getDoc
        } = window.dbMethods;

        const claimRef = doc(window.db, "reclamos", fbId);
        const publicRef = doc(window.db, "reclamos_publicos", fbId);

        // 1. Actualizar estado del reclamo privado
        await updateDoc(claimRef, {
            status: newStatus
        });

        claim.status = newStatus;

        // 2. Publicar o quitar el reclamo público
        if (newStatus === 'approved' || newStatus === 'solved') {
            const isOldFormat =
                Object.prototype.hasOwnProperty.call(claim, 'photo');

            const publicData = {
                claimId: claim.claimId,
                title: claim.title,
                category: claim.category,
                address: claim.address || '',
                description: claim.description || '',
                lat: claim.lat,
                lng: claim.lng,
                status: newStatus,
                adhesions: claim.adhesions || 0,
                createdAt: claim.createdAt
            };

            // Reclamos antiguos: foto dentro del documento principal
            if (isOldFormat) {
                publicData.photo = claim.photo || null;
            }

            // Reclamos nuevos: foto dentro de media/foto
            if (!isOldFormat) {
                publicData.hasPhoto = claim.hasPhoto === true;
            }

            // Crear o actualizar documento público
            await setDoc(publicRef, publicData);

            // Copiar imagen del reclamo privado al público
            if (!isOldFormat && claim.hasPhoto === true) {
                const sourceMediaRef = doc(
                    window.db,
                    "reclamos",
                    fbId,
                    "media",
                    "foto"
                );

                const mediaSnap = await getDoc(sourceMediaRef);

                if (!mediaSnap.exists()) {
                    throw new Error(
                        'No existe la foto en reclamos/{id}/media/foto'
                    );
                }

                const mediaData = mediaSnap.data();

                if (!mediaData.photo) {
                    throw new Error(
                        'El documento media/foto no contiene el campo photo'
                    );
                }

                const destMediaRef = doc(
                    window.db,
                    "reclamos_publicos",
                    fbId,
                    "media",
                    "foto"
                );

                await setDoc(destMediaRef, {
                    photo: mediaData.photo
                });

                state.photoCache[fbId] = mediaData.photo;

                console.log('✅ Foto copiada al documento público');
            }

            console.log('✅ Reclamo publicado correctamente');
        } else {
            // Si se rechaza, eliminar el documento público
            await deleteDoc(publicRef);

            // Eliminar también la foto pública
            const publicPhotoRef = doc(
                window.db,
                "reclamos_publicos",
                fbId,
                "media",
                "foto"
            );

            try {
                await deleteDoc(publicPhotoRef);
            } catch (photoError) {
                console.warn(
                    'No se pudo eliminar la foto pública:',
                    photoError
                );
            }

            delete state.photoCache[fbId];

            console.log('✅ Reclamo retirado de la vista pública');
        }

        // 3. Recargar la interfaz
        await loadPublicClaims();
        renderPublicClaimsList();
        renderMapPins();
        syncAdminDashboard();

        document
            .getElementById('detailPanel')
            .classList.remove('visible');

        console.log(`✅ Estado actualizado: ${newStatus}`);

    } catch (error) {
        console.error('❌ Error actualizando el reclamo:', error);
        alert(`No se pudo guardar el cambio:\n${error.message}`);
    }
}

async function deleteClaimFromDatabase(fbId) {
    const claim = state.adminClaims.find(c => c._fbId === fbId);
    if (!claim) return;

    if (!confirm(`¿Eliminar reclamo ${claim.claimId}?`)) return;

    try {
        const { doc, deleteDoc } = window.dbMethods;

        await deleteDoc(doc(window.db, "reclamos", fbId));
        try { await deleteDoc(doc(window.db, "reclamos_publicos", fbId)); } catch (e) { /* puede no existir, ok */ }

        // 🆕 Limpieza best-effort de las subcolecciones de foto (no rompe si no existen)
        try { await deleteDoc(doc(window.db, "reclamos", fbId, "media", "foto")); } catch (e) {}
        try { await deleteDoc(doc(window.db, "reclamos_publicos", fbId, "media", "foto")); } catch (e) {}

        state.adminClaims = state.adminClaims.filter(c => c._fbId !== fbId);
        state.claims = state.claims.filter(c => c._fbId !== fbId);
        delete state.photoCache[fbId]; // 🆕

        renderPublicClaimsList();
        renderMapPins();
        syncAdminDashboard();
        document.getElementById('detailPanel').classList.remove('visible');

        console.log("✓ Reclamo eliminado");
    } catch (error) {
        console.error("Error:", error);
        alert("Error al eliminar.");
    }
}

function syncAdminDashboard() {
    document.getElementById('adminStatTotal').textContent = state.adminClaims.length;
    document.getElementById('adminStatPending').textContent = state.adminClaims.filter(c => c.status === 'pending').length;
    document.getElementById('adminStatApproved').textContent = state.adminClaims.filter(c => c.status === 'approved').length;
    document.getElementById('adminStatSolved').textContent = state.adminClaims.filter(c => c.status === 'solved').length;
    document.getElementById('adminStatRejected').textContent = state.adminClaims.filter(c => c.status === 'rejected').length;

    const currentSection = document.querySelector('.admin-nav .nav-btn.active').dataset.section;
    renderAdminViewCards(currentSection);
}

function renderAdminViewCards(section) {
    const targets = state.adminClaims.filter(c => c.status === section);
    const html = targets.map((claim) => {
        const cat = CATEGORIES[claim.category] || { label: 'Reclamo' };
        const priorityLabel = getPriorityLabel(claim.adhesions || 0);
        const createdDate = new Date(claim.createdAt).toLocaleDateString('es-AR');
        return `
            <div class="admin-card">
                <div class="admin-card-id">${escapeHtml(claim.claimId)}</div>
                <div class="admin-card-name">${escapeHtml(claim.title || claim.claimId)}</div>
                <div class="admin-card-text">"${escapeHtml((claim.description || claim.address || 'Sin descripción').substring(0, 60))}..."</div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#f3f4f6; color:#374151;">Categoría: ${escapeHtml(cat.label)}</span>
                </div>
                <div class="admin-card-meta">
                    <span class="admin-card-badge" style="background:#fef3c7; color:#92400e;">Prioridad: ${priorityLabel}</span>
                    <span class="admin-card-badge" style="background:#dbeafe; color:#1e40af;">${claim.adhesions || 0} adhesiones</span>
                </div>
                <div class="admin-card-meta">Creado: ${createdDate} | Autor: ${escapeHtml(claim.name)}${claim.phone ? ' · Tel: ' + escapeHtml(claim.phone) : ''}</div>
                <button class="btn-popup-more" onclick="globalOpenDetailWindow('${claim._fbId}')">Inspeccionar</button>
            </div>
        `;
    }).join('');
    document.getElementById('adminList').innerHTML = html || '<p style="font-size:12px; color:#64748b; padding:10px; font-weight:600;">Sin registros en esta bandeja.</p>';
}

function initPoliticalCounter() {
    const startDate = new Date('2023-12-10T00:00:00');
    const targetDate = new Date('2027-12-10T00:00:00');

    const display = document.getElementById('daysCounter');
    const progressBar = document.getElementById('governmentProgressBar');

    const run = () => {
        const now = new Date();
        const totalDuration = targetDate - startDate;
        const timeElapsed = now - startDate;
        const timeRemaining = targetDate - now;

        const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));
        let percentComplete = (timeElapsed / totalDuration) * 100;
        percentComplete = Math.min(100, Math.max(0, percentComplete));

        if (progressBar) {
            progressBar.style.width = `${percentComplete.toFixed(1)}%`;
            progressBar.innerHTML = `<span style="color:white; font-weight:700; font-size:12px; text-shadow:0 1px 2px rgba(0,0,0,0.3);">${percentComplete.toFixed(1)}%</span>`;
        }
        if (display) display.textContent = `${daysRemaining} días para que arreglen esto`;
    };

    run(); // ← Ejecutar una vez al cargar
    setInterval(run, 60000); // ← Actualizar cada minuto

    const block = document.querySelector('.political-counter');
    if (block) {
        block.style.cursor = 'pointer';
        // No usamos el evento nativo 'dblclick': con touch-action:manipulation
        // (necesario para sacar el zoom por doble-tap accidental en el resto del
        // sitio) los navegadores mobile dejan de sintetizar 'dblclick' a partir de
        // dos toques, así que el doble-tap nunca llegaba a disparar nada en el
        // celular. Detectamos el "doble toque" a mano por tiempo entre 'click'
        // (que sí dispara igual con mouse y con touch), y funciona igual en ambos.
        let lastTapAt = 0;
        const DOUBLE_TAP_MS = 450;
        block.addEventListener('click', () => {
            const now = Date.now();
            if (now - lastTapAt < DOUBLE_TAP_MS) {
                document.getElementById('adminLoginModal').classList.remove('hidden');
                lastTapAt = 0;
            } else {
                lastTapAt = now;
            }
        });
    }
}

// ---------------------------------------------------------------------------
// CARGA DE DATOS
// ---------------------------------------------------------------------------

// Tope defensivo mientras no hay paginación real en la UI: evita traer la colección
// completa sin límite a medida que crece el volumen de reclamos. No afecta el
// comportamiento actual (muy por debajo de este número); es un techo de seguridad,
// no una funcionalidad de paginación (eso queda pendiente, ver resumen de cambios).
const CLAIMS_QUERY_LIMIT = 500;

async function loadPublicClaims() {
    const errorBanner = document.getElementById('dataLoadError');
    try {
        const { collection, getDocs, query, limit } = window.dbMethods;
        const q = query(collection(window.db, "reclamos_publicos"), limit(CLAIMS_QUERY_LIMIT));
        const querySnapshot = await getDocs(q);

        const cargados = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            cargados.push({
                _fbId: doc.id,
                ...data,
                adhesions: data.adhesions || 0
            });
        });

        state.claims = cargados;
        if (errorBanner) errorBanner.classList.add('hidden');
        console.log("✅ Reclamos públicos cargados:", state.claims.length);
    } catch (error) {
        console.error("❌ Error cargando reclamos públicos:", error);
        state.claims = [];
        if (errorBanner) errorBanner.classList.remove('hidden');
    }
}

async function loadAdminClaims() {
    try {
        const { collection, getDocs, query, limit } = window.dbMethods;
        const q = query(collection(window.db, "reclamos"), limit(CLAIMS_QUERY_LIMIT));
        const querySnapshot = await getDocs(q);

        const cargados = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            cargados.push({
                _fbId: doc.id,
                ...data,
                adhesions: data.adhesions || 0
            });
        });

        state.adminClaims = cargados;
        console.log("✅ Panel admin cargado:", state.adminClaims.length);
    } catch (error) {
        console.error("❌ Error cargando panel admin:", error);
        state.adminClaims = [];
    }
}