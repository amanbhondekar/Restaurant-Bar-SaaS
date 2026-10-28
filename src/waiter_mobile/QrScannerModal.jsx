import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { X, Camera, Zap, ZapOff, RefreshCw, AlertTriangle, CheckCircle2, Image as ImageIcon } from 'lucide-react';
import { setToken, enrollWithCode } from '../services/hubAuth';

export const QrScannerModal = ({ isOpen, onClose, onScanSuccess, hubUrl }) => {
  const [scannerError, setScannerError] = useState('');
  const [isStarting, setIsStarting] = useState(true);
  const [isDecoding, setIsDecoding] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scannedSuccess, setScannedSuccess] = useState(false);
  const [facingMode, setFacingMode] = useState('environment'); // 'environment' (back) | 'user' (front)
  const [usePhotoCapture, setUsePhotoCapture] = useState(false);

  const scannerRef = useRef(null);
  const isStoppingRef = useRef(false);
  const fileInputRef = useRef(null);

  // Unified Token Extractor
  const handleDecodedText = async (decodedText) => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    // Haptic feedback
    try {
      if (navigator.vibrate) navigator.vibrate(120);
    } catch {
      /* ignore */
    }

    setScannedSuccess(true);

    let token = null;
    let detectedHubUrl = null;

    // 1. URL pattern: http://192.168.31.156:4000/waiter#t=<token>
    const tokenMatch = decodedText.match(/[#&?]t(?:oken)?=([a-f0-9]{64})/i);
    if (tokenMatch) {
      token = tokenMatch[1];
      try {
        const parsed = new URL(decodedText);
        detectedHubUrl = `${parsed.protocol}//${parsed.hostname}:${parsed.port || 4000}`;
      } catch {
        /* ignore */
      }
    } else if (/[#&?]e=([A-Z0-9]{4,12})/i.test(decodedText)) {
      // Current QR shape: the URL carries the enrollment code, not a credential,
      // so the hub does not mint a token every time the KDS refreshes its QR.
      const code = decodedText.match(/[#&?]e=([A-Z0-9]{4,12})/i)[1].toUpperCase();
      let targetHub = hubUrl || window.location.origin.replace(':3000', ':4000');
      try {
        const parsed = new URL(decodedText);
        targetHub = `${parsed.protocol}//${parsed.hostname}:${parsed.port || 4000}`;
        detectedHubUrl = targetHub;
      } catch {
        /* ignore */
      }
      const enrollRes = await enrollWithCode(targetHub, code);
      if (enrollRes.ok) {
        token = enrollRes.token;
      }
    } else if (/^[a-f0-9]{64}$/i.test(decodedText.trim())) {
      token = decodedText.trim();
    } else if (/^[A-Z0-9]{6}$/i.test(decodedText.trim())) {
      const code = decodedText.trim().toUpperCase();
      const targetHub = hubUrl || window.location.origin.replace(':3000', ':4000');
      const enrollRes = await enrollWithCode(targetHub, code);
      if (enrollRes.ok) {
        token = enrollRes.token;
      }
    }

    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        /* ignore */
      }
    }

    if (token) {
      setToken(token);
      onScanSuccess({ token, hubUrl: detectedHubUrl });
      setTimeout(() => {
        onClose();
      }, 500);
    } else {
      setScannerError(`QR code found but did not match a Mejwani token: "${decodedText.slice(0, 40)}..."`);
      isStoppingRef.current = false;
      setScannedSuccess(false);
      setIsDecoding(false);
    }
  };

  // Handle Photo File Capture (Native Mobile Camera)
  const handleFileCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsDecoding(true);
    setScannerError('');

    try {
      // Create a temporary scanner instance for file decoding
      const qrScanner = scannerRef.current || new Html5Qrcode('qr-reader-container');
      scannerRef.current = qrScanner;
      const decodedText = await qrScanner.scanFile(file, false);
      await handleDecodedText(decodedText);
    } catch (err) {
      setIsDecoding(false);
      console.warn('Could not decode QR from photo:', err);
      setScannerError('Could not find a QR code in the photo. Please align the Kitchen Display QR within frame and snap again.');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setScannerError('');
    setIsStarting(true);
    setIsDecoding(false);
    setScannedSuccess(false);
    isStoppingRef.current = false;

    // Check if browser allows live stream camera (requires Secure Context HTTPS or localhost)
    const canUseLiveStream = typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      (window.isSecureContext !== false);

    if (!canUseLiveStream) {
      // Direct fallback to photo capture over plain HTTP LAN
      setIsStarting(false);
      setUsePhotoCapture(true);
      return;
    }

    const qrElementId = 'qr-reader-container';

    const startLiveScanner = async () => {
      try {
        await new Promise(r => setTimeout(r, 100));
        if (!isMounted) return;

        const html5QrCode = new Html5Qrcode(qrElementId);
        scannerRef.current = html5QrCode;

        const config = {
          fps: 15,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const edge = Math.floor(minEdge * 0.72);
            return { width: edge, height: edge };
          },
          aspectRatio: 1.0,
        };

        await html5QrCode.start(
          { facingMode },
          config,
          handleDecodedText,
          () => {} // Frame error
        );

        if (isMounted) {
          setIsStarting(false);
          setUsePhotoCapture(false);
          try {
            const track = html5QrCode.getRunningTrackCapabilities?.();
            if (track && 'torch' in track) {
              setHasTorch(true);
            }
          } catch {
            setHasTorch(false);
          }
        }
      } catch (err) {
        if (!isMounted) return;
        setIsStarting(false);
        console.warn('Live stream camera failed, switching to photo capture:', err);
        // Seamless fallback to photo capture
        setUsePhotoCapture(true);
      }
    };

    startLiveScanner();

    return () => {
      isMounted = false;
      isStoppingRef.current = true;
      if (scannerRef.current) {
        try {
          scannerRef.current.stop().catch(() => {}).then(() => {
            try {
              scannerRef.current?.clear();
            } catch {}
          });
        } catch {}
      }
    };
  }, [isOpen, facingMode, hubUrl]);

  const toggleTorch = async () => {
    if (!scannerRef.current) return;
    try {
      const nextTorch = !torchOn;
      await scannerRef.current.applyVideoConstraints({
        advanced: [{ torch: nextTorch }]
      });
      setTorchOn(nextTorch);
    } catch (err) {
      console.warn('Could not toggle torch:', err);
    }
  };

  const toggleFacingMode = () => {
    setFacingMode(prev => (prev === 'environment' ? 'user' : 'environment'));
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 110,
      background: 'rgba(0, 0, 0, 0.88)', backdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '16px'
    }}>
      {/* Hidden Native Camera Input for 100% universal browser photo capture */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={fileInputRef}
        onChange={handleFileCapture}
        style={{ display: 'none' }}
      />

      <div style={{
        width: '100%', maxWidth: '380px', background: '#18181b', borderRadius: '18px',
        overflow: 'hidden', border: '1px solid rgba(255, 255, 255, 0.12)',
        boxShadow: '0 20px 40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column'
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)', background: '#202024'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Camera size={18} style={{ color: 'var(--color-primary, #ff5722)' }} />
            <h3 style={{ margin: 0, fontSize: '15px', color: '#f4f4f5', fontWeight: 700 }}>
              Scan Kitchen Display QR
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255, 255, 255, 0.1)', border: 'none', borderRadius: '50%',
              width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#a1a1aa', cursor: 'pointer'
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Viewfinder or Photo Snap Container */}
        <div style={{
          position: 'relative', width: '100%', minHeight: '300px', background: '#000',
          overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
        }}>
          {/* Mount node for html5-qrcode */}
          <div
            id="qr-reader-container"
            style={{
              width: '100%', height: usePhotoCapture ? '1px' : '300px',
              opacity: usePhotoCapture ? 0 : 1, objectFit: 'cover'
            }}
          />

          {/* Fallback / HTTP Camera Snap Interface */}
          {usePhotoCapture && !scannedSuccess && (
            <div style={{
              padding: '28px 20px', textAlign: 'center', display: 'flex',
              flexDirection: 'column', alignItems: 'center', gap: '14px', width: '100%'
            }}>
              <div style={{
                width: '68px', height: '68px', borderRadius: '50%',
                background: 'rgba(255, 87, 34, 0.15)', border: '2px solid var(--color-primary, #ff5722)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary, #ff5722)'
              }}>
                <Camera size={34} />
              </div>

              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#f4f4f5', marginBottom: '6px' }}>
                  Camera Photo Scanner
                </div>
                <div style={{ fontSize: '12px', color: '#a1a1aa', lineHeight: 1.4, maxWidth: '280px', margin: '0 auto' }}>
                  Snap a quick photo of the QR code on the Kitchen Display screen to enroll this device.
                </div>
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isDecoding}
                className="btn btn-primary"
                style={{
                  width: '100%', maxWidth: '260px', padding: '12px', fontSize: '14px', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  boxShadow: '0 4px 14px rgba(255, 87, 34, 0.4)'
                }}
              >
                {isDecoding ? (
                  <>
                    <RefreshCw size={16} className="spin" />
                    <span>Decoding QR...</span>
                  </>
                ) : (
                  <>
                    <Camera size={18} />
                    <span>Open Camera & Snap QR</span>
                  </>
                )}
              </button>

              {scannerError && (
                <div style={{
                  padding: '8px 12px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: '11px',
                  display: 'flex', alignItems: 'center', gap: '6px', textAlign: 'left'
                }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                  <span>{scannerError}</span>
                </div>
              )}
            </div>
          )}

          {/* Loading Indicator for Live Stream */}
          {!usePhotoCapture && isStarting && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: '10px', color: '#a1a1aa'
            }}>
              <RefreshCw size={28} className="spin" style={{ color: 'var(--color-primary, #ff5722)' }} />
              <span style={{ fontSize: '12px' }}>Starting camera...</span>
            </div>
          )}

          {/* Success Overlay Flash */}
          {scannedSuccess && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(16, 185, 129, 0.9)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              color: '#ffffff', gap: '8px', zIndex: 10
            }}>
              <CheckCircle2 size={48} />
              <span style={{ fontSize: '17px', fontWeight: 800 }}>QR Enrolled Successfully!</span>
              <span style={{ fontSize: '12px', opacity: 0.9 }}>Unlocking your restaurant tables...</span>
            </div>
          )}

          {/* Live Scanning Reticle Overlay */}
          {!usePhotoCapture && !isStarting && !scannerError && !scannedSuccess && (
            <div style={{
              position: 'absolute', width: '220px', height: '220px',
              pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <div style={{
                position: 'absolute', inset: 0,
                border: '2px dashed rgba(255, 255, 255, 0.4)', borderRadius: '16px'
              }} />
              
              <div style={{
                position: 'absolute', top: -2, left: -2, width: '24px', height: '24px',
                borderTop: '4px solid var(--color-primary, #ff5722)', borderLeft: '4px solid var(--color-primary, #ff5722)',
                borderTopLeftRadius: '12px'
              }} />
              <div style={{
                position: 'absolute', top: -2, right: -2, width: '24px', height: '24px',
                borderTop: '4px solid var(--color-primary, #ff5722)', borderRight: '4px solid var(--color-primary, #ff5722)',
                borderTopRightRadius: '12px'
              }} />
              <div style={{
                position: 'absolute', bottom: -2, left: -2, width: '24px', height: '24px',
                borderBottom: '4px solid var(--color-primary, #ff5722)', borderLeft: '4px solid var(--color-primary, #ff5722)',
                borderBottomLeftRadius: '12px'
              }} />
              <div style={{
                position: 'absolute', bottom: -2, right: -2, width: '24px', height: '24px',
                borderBottom: '4px solid var(--color-primary, #ff5722)', borderRight: '4px solid var(--color-primary, #ff5722)',
                borderBottomRightRadius: '12px'
              }} />

              <div style={{
                position: 'absolute', left: '10px', right: '10px', height: '2px',
                background: 'linear-gradient(90deg, transparent, var(--color-primary, #ff5722), transparent)',
                boxShadow: '0 0 10px var(--color-primary, #ff5722)',
                animation: 'scanline 2s infinite ease-in-out'
              }} />
            </div>
          )}
        </div>

        {/* Viewfinder Controls / Alternate Action */}
        <div style={{
          padding: '12px 16px', background: '#202024', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)'
        }}>
          {!usePhotoCapture ? (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)', border: 'none', borderRadius: '8px',
                  padding: '6px 10px', color: '#ffffff', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px'
                }}
              >
                <ImageIcon size={14} />
                <span>Snap Photo</span>
              </button>

              <div style={{ display: 'flex', gap: '8px' }}>
                {hasTorch && (
                  <button
                    onClick={toggleTorch}
                    style={{
                      background: torchOn ? 'var(--color-primary, #ff5722)' : 'rgba(255, 255, 255, 0.1)',
                      border: 'none', borderRadius: '8px', padding: '6px 10px',
                      color: '#ffffff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px'
                    }}
                  >
                    {torchOn ? <Zap size={14} /> : <ZapOff size={14} />}
                    <span>{torchOn ? 'On' : 'Light'}</span>
                  </button>
                )}

                <button
                  onClick={toggleFacingMode}
                  style={{
                    background: 'rgba(255, 255, 255, 0.1)', border: 'none', borderRadius: '8px',
                    padding: '6px 10px', color: '#ffffff', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px'
                  }}
                >
                  <RefreshCw size={14} />
                  <span>Flip</span>
                </button>
              </div>
            </>
          ) : (
            <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: '#a1a1aa' }}>
                Or enter code: <strong>9KZXEC</strong>
              </span>
              <button
                onClick={onClose}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '11px', padding: '4px 8px' }}
              >
                Manual Entry
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes scanline {
          0% { top: 15%; opacity: 0.2; }
          50% { top: 85%; opacity: 1; }
          100% { top: 15%; opacity: 0.2; }
        }
        #qr-reader-container video {
          object-fit: cover !important;
          width: 100% !important;
          height: 100% !important;
        }
      `}</style>
    </div>
  );
};
