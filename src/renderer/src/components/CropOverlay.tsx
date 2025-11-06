import { useState, useCallback, useRef, useEffect, CSSProperties } from 'react';
import { CropRect } from '../../../../types';

interface CropOverlayProps {
  videoElement: HTMLVideoElement;
  cropRect: CropRect;
  onChange: (rect: CropRect) => void;
  videoWidth: number;
  videoHeight: number;
}

type DragHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | null;

const ensureEven = (n: number) => Math.floor(n / 2) * 2;

export function CropOverlay({ videoElement, cropRect, onChange, videoWidth, videoHeight }: CropOverlayProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragHandle, setDragHandle] = useState<DragHandle>(null);
  const [, setResizeTrigger] = useState(0); // Force re-render on resize
  const [isReady, setIsReady] = useState(false); // Track if dimensions are valid
  const dragStartRef = useRef<{ x: number, y: number, rect: CropRect } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if container dimensions are valid and set ready state
  useEffect(() => {
    const checkReady = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && videoWidth > 0 && videoHeight > 0) {
          setIsReady(true);
        }
      }
    };

    // Check immediately and after a short delay to handle async rendering
    checkReady();
    const timer = setTimeout(checkReady, 50);
    return () => clearTimeout(timer);
  }, [videoWidth, videoHeight]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      setResizeTrigger(prev => prev + 1);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Get video dimensions and scale
  const getVideoScale = useCallback(() => {
    // Use overlay container dimensions instead of video element's clientWidth/clientHeight
    // This works correctly even with FFmpeg-assisted playback where the main video element
    // might not have valid client dimensions
    // Use getBoundingClientRect() which is more reliable than clientWidth/clientHeight
    const rect = containerRef.current?.getBoundingClientRect();
    const displayWidth = rect?.width || 0;
    const displayHeight = rect?.height || 0;

    // Account for object-fit: contain
    const videoAspect = videoWidth / videoHeight;
    const displayAspect = displayWidth / displayHeight;

    let scaleX: number, scaleY: number, offsetX = 0, offsetY = 0;

    if (videoAspect > displayAspect) {
      // Video is wider - fit to width
      scaleX = displayWidth / videoWidth;
      scaleY = scaleX;
      offsetY = (displayHeight - (videoHeight * scaleY)) / 2;
    } else {
      // Video is taller - fit to height
      scaleY = displayHeight / videoHeight;
      scaleX = scaleY;
      offsetX = (displayWidth - (videoWidth * scaleX)) / 2;
    }

    return { scaleX, scaleY, offsetX, offsetY, videoWidth, videoHeight, displayWidth, displayHeight };
  }, [videoWidth, videoHeight]);

  // Convert video coordinates to display coordinates
  const videoToDisplay = useCallback((rect: CropRect) => {
    const { scaleX, scaleY, offsetX, offsetY } = getVideoScale();
    return {
      x: rect.x * scaleX + offsetX,
      y: rect.y * scaleY + offsetY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    };
  }, [getVideoScale]);

  // Convert display coordinates to video coordinates
  const displayToVideo = useCallback((x: number, y: number) => {
    const { scaleX, scaleY, offsetX, offsetY } = getVideoScale();
    return {
      x: Math.round((x - offsetX) / scaleX),
      y: Math.round((y - offsetY) / scaleY),
    };
  }, [getVideoScale]);

  const handleMouseDown = useCallback((e: React.MouseEvent, handle: DragHandle) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragHandle(handle);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragStartRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      rect: { ...cropRect },
    };
  }, [cropRect]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragHandle || !dragStartRef.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const currentX = e.clientX - containerRect.left;
    const currentY = e.clientY - containerRect.top;
    const deltaX = currentX - dragStartRef.current.x;
    const deltaY = currentY - dragStartRef.current.y;

    const { videoWidth, videoHeight } = getVideoScale();
    const { x: origX, y: origY, width: origWidth, height: origHeight } = dragStartRef.current.rect;

    const displayRect = videoToDisplay(dragStartRef.current.rect);
    let newDisplayRect = { ...displayRect };

    // Calculate new rect based on handle
    if (dragHandle === 'move') {
      newDisplayRect.x = displayRect.x + deltaX;
      newDisplayRect.y = displayRect.y + deltaY;
    } else if (dragHandle === 'nw') {
      newDisplayRect.x = displayRect.x + deltaX;
      newDisplayRect.y = displayRect.y + deltaY;
      newDisplayRect.width = displayRect.width - deltaX;
      newDisplayRect.height = displayRect.height - deltaY;
    } else if (dragHandle === 'ne') {
      newDisplayRect.y = displayRect.y + deltaY;
      newDisplayRect.width = displayRect.width + deltaX;
      newDisplayRect.height = displayRect.height - deltaY;
    } else if (dragHandle === 'sw') {
      newDisplayRect.x = displayRect.x + deltaX;
      newDisplayRect.width = displayRect.width - deltaX;
      newDisplayRect.height = displayRect.height + deltaY;
    } else if (dragHandle === 'se') {
      newDisplayRect.width = displayRect.width + deltaX;
      newDisplayRect.height = displayRect.height + deltaY;
    } else if (dragHandle === 'n') {
      newDisplayRect.y = displayRect.y + deltaY;
      newDisplayRect.height = displayRect.height - deltaY;
    } else if (dragHandle === 's') {
      newDisplayRect.height = displayRect.height + deltaY;
    } else if (dragHandle === 'e') {
      newDisplayRect.width = displayRect.width + deltaX;
    } else if (dragHandle === 'w') {
      newDisplayRect.x = displayRect.x + deltaX;
      newDisplayRect.width = displayRect.width - deltaX;
    }

    // Convert back to video coordinates
    const topLeft = displayToVideo(newDisplayRect.x, newDisplayRect.y);
    const bottomRight = displayToVideo(newDisplayRect.x + newDisplayRect.width, newDisplayRect.y + newDisplayRect.height);

    let newRect: CropRect = {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };

    // Ensure minimum size (50px)
    const minSize = 50;
    if (newRect.width < minSize) newRect.width = minSize;
    if (newRect.height < minSize) newRect.height = minSize;

    // Constrain to video bounds
    if (newRect.x < 0) newRect.x = 0;
    if (newRect.y < 0) newRect.y = 0;
    if (newRect.x + newRect.width > videoWidth) {
      if (dragHandle === 'move') {
        newRect.x = videoWidth - newRect.width;
      } else {
        newRect.width = videoWidth - newRect.x;
      }
    }
    if (newRect.y + newRect.height > videoHeight) {
      if (dragHandle === 'move') {
        newRect.y = videoHeight - newRect.height;
      } else {
        newRect.height = videoHeight - newRect.y;
      }
    }

    // Ensure even dimensions for H.264 compatibility
    newRect.width = ensureEven(newRect.width);
    newRect.height = ensureEven(newRect.height);
    newRect.x = ensureEven(newRect.x);
    newRect.y = ensureEven(newRect.y);

    onChange(newRect);
  }, [isDragging, dragHandle, getVideoScale, videoToDisplay, displayToVideo, onChange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragHandle(null);
    dragStartRef.current = null;
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const displayRect = videoToDisplay(cropRect);

  const handleStyle: CSSProperties = {
    position: 'absolute',
    width: 12,
    height: 12,
    background: 'white',
    border: '2px solid black',
    borderRadius: '50%',
    cursor: 'pointer',
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: isDragging ? 'all' : 'auto',
        opacity: isReady ? 1 : 0,
        transition: 'opacity 0.15s ease-in',
      }}
    >
      {/* Dark overlay using box-shadow trick */}
      <div
        style={{
          position: 'absolute',
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
          border: '2px solid white',
          cursor: 'move',
          pointerEvents: 'auto',
        }}
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      >
        {/* Dimension label */}
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            background: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            padding: '2px 6px',
            fontSize: 12,
            borderRadius: 3,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {cropRect.width}×{cropRect.height}
        </div>

        {/* Corner handles */}
        <div
          style={{ ...handleStyle, left: -6, top: -6, cursor: 'nw-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'nw')}
        />
        <div
          style={{ ...handleStyle, right: -6, top: -6, cursor: 'ne-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'ne')}
        />
        <div
          style={{ ...handleStyle, left: -6, bottom: -6, cursor: 'sw-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'sw')}
        />
        <div
          style={{ ...handleStyle, right: -6, bottom: -6, cursor: 'se-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'se')}
        />

        {/* Edge handles */}
        <div
          style={{ ...handleStyle, left: '50%', top: -6, transform: 'translateX(-50%)', cursor: 'n-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'n')}
        />
        <div
          style={{ ...handleStyle, left: '50%', bottom: -6, transform: 'translateX(-50%)', cursor: 's-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 's')}
        />
        <div
          style={{ ...handleStyle, right: -6, top: '50%', transform: 'translateY(-50%)', cursor: 'e-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'e')}
        />
        <div
          style={{ ...handleStyle, left: -6, top: '50%', transform: 'translateY(-50%)', cursor: 'w-resize' }}
          onMouseDown={(e) => handleMouseDown(e, 'w')}
        />
      </div>
    </div>
  );
}
