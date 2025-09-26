// js/viz.js
(function() {
  // 설정 상수
  const CONFIG = {
    CHART: {
      DURATION: 3000,
      REFRESH_RATE: 16, // 60Hz
      MAX_POINTS: 1000
    },
    UI: {
      IDLE_DELAY: 800,
      MAX_TABLE_ROWS: 100,
      CURSOR_BLINK_DURATION: 2000
    },
    ANALOG: {
      ENABLED: true,
      PRESSURE_THRESHOLD: 0.1, // 0.1 이상이면 키 입력으로 인식 (0-1 범위)
      MAX_PRESSURE: 1.0, // Wooting SDK는 0-1 범위 사용
      POLLING_RATE: 16, // 60Hz 폴링
      WOOTING_DETECTED: false
    }
  };

  // 1) 키보드 시각화용 매핑
  const keyElements = Array.from(document.querySelectorAll('.key'));
  const keyMap = keyElements.reduce((map, el) => {
    map[el.dataset.code] = el;
    return map;
  }, {});

  // 2) 주요 DOM 요소 참조
  const textInput         = document.getElementById('textInput');
  const showChars         = document.getElementById('showChars');
  const keystrokeBody     = document.querySelector('#keystrokeTable tbody');
  const keystrokeWrapper  = document.querySelector('.keystroke-table-wrapper');
  
  // 아날로그 관련 DOM 요소
  const enableAnalog      = document.getElementById('enableAnalog');
  const analogBody        = document.querySelector('#analogTable tbody');
  const analogWrapper     = document.querySelector('.analog-table-wrapper');

  // 3) 커서 생성 및 초기 배치
  const cursor = document.createElement('span');
  cursor.id = 'cursor';
  textInput.appendChild(cursor);

  // 4) Chart.js + Streaming 플러그인 초기화
  Chart.register(ChartDataLabels, ChartStreaming);

  const ctx = document.getElementById('keystrokeChart').getContext('2d');
  const analogCtx = document.getElementById('analogChart').getContext('2d');
  const keystrokeChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'State',
        data: [],            // 여기에 push 해주면 onRefresh 없이 바로 반영
        borderColor: 'royalblue',
        backgroundColor: 'royalblue',
        pointRadius: 3,
        stepped: true,
        datalabels: {
          align: 'top',
          formatter: function(_, context) {
            return context.dataset.data[context.dataIndex].key;
          }
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        datalabels: { color: 'black', font: { size: 10 } }
      },
      scales: {
        x: {
          type: 'realtime',       // ← 실시간 Streaming 모드
          realtime: {
            duration: CONFIG.CHART.DURATION,
            refresh: CONFIG.CHART.REFRESH_RATE,
            delay: 0,             // 딜레이 없음
            pause: false,         // 차트 일시정지 여부
            ttl: undefined,       // 데이터 TTL (optional)
            onRefresh: chart => {
              // onRefresh 내부에서 데이터를 추가할 수도 있지만,
              // 우리는 logKeystroke() 호출 시 직접 data.push() 했으므로
              // 여기서는 별도 로직이 필요 없습니다.
            }
          },
          title: { display: true, text: 'Time (ms)' }
        },
        y: {
          min: -0.1,
          max: 1.1,
          ticks: { stepSize: 1 },
          title: { display: true, text: 'State' }
        }
      }
    }
  });

  // 아날로그 차트 초기화
  const analogChart = new Chart(analogCtx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Pressure',
        data: [],
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.1,
        datalabels: {
          align: 'top',
          formatter: function(_, context) {
            return context.dataset.data[context.dataIndex].key;
          }
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        datalabels: { color: 'black', font: { size: 8 } }
      },
      scales: {
        x: {
          type: 'realtime',
          realtime: {
            duration: CONFIG.CHART.DURATION,
            refresh: CONFIG.CHART.REFRESH_RATE,
            delay: 0,
            pause: false,
            ttl: undefined
          },
          title: { display: true, text: 'Time (ms)' }
        },
        y: {
          min: 0,
          max: CONFIG.ANALOG.MAX_PRESSURE,
          ticks: { 
            stepSize: 0.2,
            callback: function(value) {
              return (value * 100).toFixed(0) + '%';
            }
          },
          title: { display: true, text: 'Analog Depth (0-1)' }
        }
      }
    }
  });

  // 5) Wooting SDK 아날로그 데이터 관리
  let analogData = new Map(); // key -> { depth, lastUpdate }
  let analogPollingInterval;
  let wootingSDK = null;

  // Wooting SDK 초기화 및 감지
  async function initializeWootingSDK() {
    try {
      // WebHID API를 사용하여 Wooting 키보드 감지
      if ('hid' in navigator) {
        const devices = await navigator.hid.getDevices();
        const wootingDevice = devices.find(device => 
          device.vendorId === 0x31E3 && // Wooting의 Vendor ID
          (device.productId === 0x1100 || device.productId === 0x1101) // Wooting One/Two
        );
        
        if (wootingDevice) {
          CONFIG.ANALOG.WOOTING_DETECTED = true;
          console.log('Wooting keyboard detected:', wootingDevice);
          updateAnalogStatus('Wooting keyboard detected!');
          return true;
        }
      }
      
      // WebHID가 지원되지 않거나 Wooting이 감지되지 않은 경우
      CONFIG.ANALOG.WOOTING_DETECTED = false;
      updateAnalogStatus('Wooting keyboard not detected. Using simulation mode.');
      return false;
    } catch (error) {
      console.error('Error initializing Wooting SDK:', error);
      CONFIG.ANALOG.WOOTING_DETECTED = false;
      updateAnalogStatus('Error detecting Wooting keyboard. Using simulation mode.');
      return false;
    }
  }

  // 아날로그 상태 업데이트
  function updateAnalogStatus(message) {
    const statusElement = document.querySelector('.analog-info span');
    if (statusElement) {
      statusElement.textContent = message;
    }
  }

  // 실제 Wooting 아날로그 데이터 폴링
  async function pollWootingAnalogData() {
    if (!CONFIG.ANALOG.ENABLED || !enableAnalog.checked) return;
    
    const now = Date.now();
    const keysToUpdate = [];
    
    if (CONFIG.ANALOG.WOOTING_DETECTED) {
      try {
        // 실제 Wooting SDK를 통한 아날로그 데이터 읽기
        // 여기서는 WebHID를 통해 실제 데이터를 읽어야 함
        const devices = await navigator.hid.getDevices();
        const wootingDevice = devices.find(device => 
          device.vendorId === 0x31E3
        );
        
        if (wootingDevice && wootingDevice.opened) {
          // 실제 HID 리포트를 읽어서 아날로그 값 추출
          // 이 부분은 Wooting의 실제 HID 프로토콜에 따라 구현되어야 함
          await readWootingHIDReport(wootingDevice, keysToUpdate, now);
        }
      } catch (error) {
        console.error('Error reading Wooting data:', error);
        // 에러 발생 시 시뮬레이션 모드로 전환
        CONFIG.ANALOG.WOOTING_DETECTED = false;
        updateAnalogStatus('Wooting communication error. Using simulation mode.');
      }
    }
    
    // Wooting이 감지되지 않았거나 에러가 발생한 경우 시뮬레이션
    if (!CONFIG.ANALOG.WOOTING_DETECTED) {
      simulateAnalogInput(keysToUpdate, now);
    }
    
    // 업데이트된 키들에 대해 차트 및 테이블 업데이트
    keysToUpdate.forEach(({ key, depth }) => {
      if (depth > CONFIG.ANALOG.PRESSURE_THRESHOLD || depth === 0) {
        logAnalogInput(key, depth, now);
      }
    });
  }

  // Wooting HID 리포트 읽기 (실제 구현 필요)
  async function readWootingHIDReport(device, keysToUpdate, now) {
    try {
      // Wooting의 실제 HID 리포트 구조에 따라 구현
      // 일반적으로 Wooting은 64바이트 리포트를 사용
      const reportData = new Uint8Array(64);
      
      // 실제 구현에서는 device.receiveFeatureReport() 또는 
      // device.addEventListener('inputreport')를 사용해야 함
      
      // 임시로 현재 눌린 키들의 아날로그 값 시뮬레이션
      keyElements.forEach(keyEl => {
        if (keyEl.classList.contains('active')) {
          const keyCode = keyEl.dataset.code;
          // 실제 Wooting에서는 키 코드를 HID 스캔 코드로 변환해야 함
          const hidScanCode = keyCodeToHIDScanCode(keyCode);
          if (hidScanCode !== -1) {
            // 실제 아날로그 depth 값 (0-1)
            const depth = Math.random() * 0.8 + 0.2; // 0.2-1.0 범위로 시뮬레이션
            keysToUpdate.push({ key: keyCode, depth });
          }
        }
      });
    } catch (error) {
      console.error('Error reading HID report:', error);
    }
  }

  // 키 코드를 HID 스캔 코드로 변환
  function keyCodeToHIDScanCode(keyCode) {
    const scanCodeMap = {
      'KeyA': 0x04, 'KeyB': 0x05, 'KeyC': 0x06, 'KeyD': 0x07,
      'KeyE': 0x08, 'KeyF': 0x09, 'KeyG': 0x0A, 'KeyH': 0x0B,
      'KeyI': 0x0C, 'KeyJ': 0x0D, 'KeyK': 0x0E, 'KeyL': 0x0F,
      'KeyM': 0x10, 'KeyN': 0x11, 'KeyO': 0x12, 'KeyP': 0x13,
      'KeyQ': 0x14, 'KeyR': 0x15, 'KeyS': 0x16, 'KeyT': 0x17,
      'KeyU': 0x18, 'KeyV': 0x19, 'KeyW': 0x1A, 'KeyX': 0x1B,
      'KeyY': 0x1C, 'KeyZ': 0x1D,
      'Digit1': 0x1E, 'Digit2': 0x1F, 'Digit3': 0x20, 'Digit4': 0x21,
      'Digit5': 0x22, 'Digit6': 0x23, 'Digit7': 0x24, 'Digit8': 0x25,
      'Digit9': 0x26, 'Digit0': 0x27,
      'Space': 0x2C, 'Enter': 0x28, 'Backspace': 0x2A,
      'Tab': 0x2B, 'ShiftLeft': 0xE1, 'ShiftRight': 0xE5,
      'CapsLock': 0x39
    };
    return scanCodeMap[keyCode] || -1;
  }

  // 시뮬레이션 모드 (Wooting이 감지되지 않은 경우)
  function simulateAnalogInput(keysToUpdate, now) {
    keyElements.forEach(keyEl => {
      if (keyEl.classList.contains('active')) {
        const keyCode = keyEl.dataset.code;
        const currentData = analogData.get(keyCode) || { depth: 0, lastUpdate: now };
        
        // 아날로그 depth 증가 시뮬레이션 (0-1 범위)
        if (currentData.depth < CONFIG.ANALOG.MAX_PRESSURE) {
          currentData.depth = Math.min(
            CONFIG.ANALOG.MAX_PRESSURE, 
            currentData.depth + 0.05 // 더 부드러운 증가
          );
        }
        
        currentData.lastUpdate = now;
        analogData.set(keyCode, currentData);
        keysToUpdate.push({ key: keyCode, depth: currentData.depth });
      }
    });
    
    // 눌리지 않은 키들의 depth 감소
    analogData.forEach((data, keyCode) => {
      if (!keyElements.find(el => el.dataset.code === keyCode)?.classList.contains('active')) {
        if (data.depth > 0) {
          data.depth = Math.max(0, data.depth - 0.1); // 더 빠른 감소
          data.lastUpdate = now;
          analogData.set(keyCode, data);
          keysToUpdate.push({ key: keyCode, depth: data.depth });
        }
      }
    });
  }

  // 아날로그 입력 로깅 함수 (0-1 범위)
  function logAnalogInput(key, depth, timestamp) {
    // 테이블에 추가
    const tr = document.createElement('tr');
    const depthPercent = (depth * 100).toFixed(1);
    const cells = [
      timestamp.toString(),
      key,
      depth.toFixed(3), // 0-1 범위로 표시
      depth > CONFIG.ANALOG.PRESSURE_THRESHOLD ? 'Active' : 'Inactive'
    ];
    
    cells.forEach((cellData, index) => {
      const td = document.createElement('td');
      td.textContent = cellData;
      
      // depth 수준에 따른 색상 클래스 추가 (0-1 범위 기준)
      if (index === 2) { // Depth 컬럼
        if (depth < 0.3) td.classList.add('pressure-low');
        else if (depth < 0.7) td.classList.add('pressure-medium');
        else td.classList.add('pressure-high');
      }
      
      tr.appendChild(td);
    });
    
    analogBody.appendChild(tr);
    
    // 테이블 행 수 제한
    const rows = analogBody.children;
    if (rows.length > CONFIG.UI.MAX_TABLE_ROWS) {
      analogBody.removeChild(rows[0]);
    }
    
    analogWrapper.scrollTop = analogWrapper.scrollHeight;
    
    // 차트에 포인트 추가 (0-1 범위)
    analogChart.data.datasets[0].data.push({
      x: timestamp,
      y: depth,
      key: key
    });
    
    // 데이터 포인트 수 제한
    if (analogChart.data.datasets[0].data.length > CONFIG.CHART.MAX_POINTS) {
      analogChart.data.datasets[0].data.shift();
    }
    
    // 3초 이전 데이터 제거
    const cutoff = Date.now() - CONFIG.CHART.DURATION;
    analogChart.data.datasets[0].data =
      analogChart.data.datasets[0].data.filter(pt => pt.x >= cutoff);
    
    // 차트 업데이트
    if (!analogChart._updatePending) {
      analogChart._updatePending = true;
      requestAnimationFrame(() => {
        analogChart.update('none');
        analogChart._updatePending = false;
      });
    }
  }

  // 6) Keystroke 테이블 & 차트 동시 로깅 함수
  function logKeystroke(key, keyCode, code, isDown) {
    const tr = document.createElement('tr');
    const unixtime = Date.now(); // ms 단위
    
    // 안전한 DOM 조작 (XSS 방지)
    const cells = [
      unixtime.toString(),
      key,
      keyCode.toString(),
      code,
      isDown ? 'Down' : 'Up'
    ];
    
    cells.forEach(cellData => {
      const td = document.createElement('td');
      td.textContent = cellData;
      tr.appendChild(td);
    });
    
    keystrokeBody.appendChild(tr);
    
    // 테이블 행 수 제한 (메모리 관리)
    const rows = keystrokeBody.children;
    if (rows.length > CONFIG.UI.MAX_TABLE_ROWS) {
      keystrokeBody.removeChild(rows[0]);
    }
    
    keystrokeWrapper.scrollTop = keystrokeWrapper.scrollHeight;

    // 그래프에 포인트 추가
    keystrokeChart.data.datasets[0].data.push({
      x: unixtime,
      y: isDown ? 1 : 0,
      key
    });
    
    // 데이터 포인트 수 제한 (성능 최적화)
    if (keystrokeChart.data.datasets[0].data.length > CONFIG.CHART.MAX_POINTS) {
      keystrokeChart.data.datasets[0].data.shift();
    }
    
    // 3초 이전 데이터는 제거
    const cutoff = Date.now() - CONFIG.CHART.DURATION;
    keystrokeChart.data.datasets[0].data =
      keystrokeChart.data.datasets[0].data.filter(pt => pt.x >= cutoff);
    
    // X축 범위 갱신
    keystrokeChart.options.scales.x.min = cutoff;
    keystrokeChart.options.scales.x.max = Date.now();
    
    // 리렌더링 (throttle 적용)
    if (!keystrokeChart._updatePending) {
      keystrokeChart._updatePending = true;
      requestAnimationFrame(() => {
        keystrokeChart.update('none');
        keystrokeChart._updatePending = false;
      });
    }
  }

  // 6) Show Characters 토글 처리
  showChars.addEventListener('change', () => {
    Array.from(textInput.children)
      .filter(el => el !== cursor)
      .forEach(span => {
        if (showChars.checked) {
          span.classList.remove('bullet');
          span.textContent = span.dataset.char;
        } else {
          span.classList.add('bullet');
          span.textContent = '';
        }
      });
    textInput.appendChild(cursor);
    cursor.classList.remove('solid');
    showChars.blur();
  });

  // 7) Wooting 아날로그 폴링 시작
  function startAnalogPolling() {
    if (analogPollingInterval) {
      clearInterval(analogPollingInterval);
    }
    
    analogPollingInterval = setInterval(pollWootingAnalogData, CONFIG.ANALOG.POLLING_RATE); // 60Hz
  }
  
  function stopAnalogPolling() {
    if (analogPollingInterval) {
      clearInterval(analogPollingInterval);
      analogPollingInterval = null;
    }
  }
  
  // 아날로그 토글 이벤트
  enableAnalog.addEventListener('change', () => {
    if (enableAnalog.checked) {
      startAnalogPolling();
    } else {
      stopAnalogPolling();
    }
  });
  
  // 초기화: Wooting SDK 감지 및 아날로그 폴링 시작
  async function initializeAnalogSystem() {
    await initializeWootingSDK();
    startAnalogPolling();
  }
  
  // 초기 아날로그 시스템 시작
  initializeAnalogSystem();

  // 8) 커서 깜빡임 제어용
  let blinkTimeout;

  // 9) 키 이벤트 핸들러
  function handleKeyEvent(e) {
    // 키보드 비주얼 하이라이트
    const keyEl = keyMap[e.code];
    if (keyEl) keyEl.classList.toggle('active', e.type === 'keydown');

    if (e.code === 'Tab') e.preventDefault();

    if (e.type === 'keydown') {
      clearTimeout(blinkTimeout);
      cursor.classList.add('solid');

      // 텍스트 입력 처리
      if (e.key === 'Enter') {
        Array.from(textInput.children)
          .filter(el => el !== cursor)
          .forEach(el => el.remove());
        textInput.appendChild(cursor);
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        const items = Array.from(textInput.children).filter(el => el !== cursor);
        if (items.length) items.pop().remove();
        textInput.appendChild(cursor);
      } else if (e.key.length === 1) {
        const span = document.createElement('span');
        span.dataset.char = e.key;
        if (e.key === ' ') span.classList.add('space');
        if (showChars.checked) {
          span.textContent = (e.key === ' ' ? '\u00A0' : e.key);
        } else {
          span.classList.add('bullet');
          span.textContent = '';
        }
        textInput.appendChild(span);
        textInput.appendChild(cursor);
      }

      textInput.scrollTop = textInput.scrollHeight;
      logKeystroke(e.key, e.keyCode, e.code, true);
      blinkTimeout = setTimeout(() => cursor.classList.remove('solid'), CONFIG.UI.IDLE_DELAY);
    }
    else if (e.type === 'keyup') {
      logKeystroke(e.key, e.keyCode, e.code, false);
    }
  }

  // 10) 이벤트 리스너 등록
  const eventHandlers = {
    keydown: handleKeyEvent,
    keyup: handleKeyEvent,
    blur: () => {
      keyElements.forEach(el => el.classList.remove('active'));
    },
    beforeunload: () => {
      // 메모리 정리
      if (blinkTimeout) {
        clearTimeout(blinkTimeout);
      }
      if (analogPollingInterval) {
        clearInterval(analogPollingInterval);
      }
      // 이벤트 리스너 제거
      window.removeEventListener('keydown', eventHandlers.keydown);
      window.removeEventListener('keyup', eventHandlers.keyup);
      window.removeEventListener('blur', eventHandlers.blur);
      window.removeEventListener('beforeunload', eventHandlers.beforeunload);
    }
  };

  window.addEventListener('keydown', eventHandlers.keydown);
  window.addEventListener('keyup', eventHandlers.keyup);
  window.addEventListener('blur', eventHandlers.blur);
  window.addEventListener('beforeunload', eventHandlers.beforeunload);
})();