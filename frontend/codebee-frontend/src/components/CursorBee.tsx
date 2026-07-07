import { useEffect, useRef } from 'react';
import BeeIcon from './BeeIcon';
import './CursorBee.css';

// 실제 마우스 커서를 숨기고(index.css) 이 벌이 대신 마우스를 따라다니며 날갯짓한다.
// 텍스트 입력창 위에서는 입력 위치를 알아볼 수 있도록 숨기고 기본 텍스트 커서를 보여준다.
function CursorBee() {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    function isTextTarget(target: EventTarget | null) {
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    }

    function onMove(e: MouseEvent) {
      if (!el) return;
      el.style.transform = `translate3d(${e.clientX - 13}px, ${e.clientY - 13}px, 0)`;
      el.style.opacity = isTextTarget(e.target) ? '0' : '1';
    }

    function onLeave() {
      if (el) el.style.opacity = '0';
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onLeave);
    };
  }, []);

  return (
    <div ref={elRef} className="cursor-bee" aria-hidden="true">
      <BeeIcon flapping />
    </div>
  );
}

export default CursorBee;
