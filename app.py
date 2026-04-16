import os, cv2, time, threading, io
from flask import (Flask, render_template, Response,
                   jsonify, request, send_file, send_from_directory)
from datetime import datetime
from werkzeug.utils import secure_filename
from ultralytics import YOLO
from urllib.parse import urlparse
import numpy as np

app = Flask(__name__, template_folder='web', static_folder='web')
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

from database import load_students_from_file

# Load YOLO model
MODEL_PATH = os.path.join(os.path.dirname(__file__), "best.pt")
yolo_model = None
if os.path.exists(MODEL_PATH):
    yolo_model = YOLO(MODEL_PATH)
    print(f"[YOLO] Loaded: {MODEL_PATH}")
else:
    print("[YOLO] WARNING: best.pt not found — YOLO detection disabled")

CLASS_USING_PHONE    = "Using Phone"
CLASS_LEANING        = "Leaning to Copy"
CLASS_SHARING        = "Sharing Answers"

WATCHED_CLASSES = { CLASS_USING_PHONE, CLASS_LEANING, CLASS_SHARING }

CLASS_COLOUR = {
    CLASS_USING_PHONE:    (0,   0, 255),
    CLASS_LEANING:        (0, 140, 255),
    CLASS_SHARING:        (180,  0, 220),
}

PRIORITY = [ CLASS_USING_PHONE, CLASS_LEANING, CLASS_SHARING ]

EVIDENCE_CLASSES = WATCHED_CLASSES
CONF_THRESHOLD   = 0.40

# Global variables to keep track of the exam state and alerts
students        = {}
evidence_log    = []
alert_queue     = []
exam_running    = False
students_loaded = False
session_ended   = False
camera_source   = 0
frame_store     = None
frame_lock      = threading.Lock()

live_ai_score   = 0.0
last_alert_text = ""
last_alert_conf = 0

last_evidence_ts  = 0.0
last_detection_ts = 0.0

EVIDENCE_DIR = os.path.join(os.path.dirname(__file__), "web", "evidence")
os.makedirs(EVIDENCE_DIR, exist_ok=True)

# Function to save a screenshot when cheating is detected
def save_evidence(crop, class_name, conf):
    ts    = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    fname = f"ev_{ts}.jpg"
    cv2.imwrite(os.path.join(EVIDENCE_DIR, fname), crop)
    score_pct = round(conf * 100)
    entry = {
        "id":         len(evidence_log) + 1,
        "reason":     class_name,
        "confidence": score_pct,
        "timestamp":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "file":       f"evidence_files/{fname}"
    }
    evidence_log.append(entry)
    alert_queue.append({
        "type": "warning",
        "msg":  f"⚠ {class_name} ({score_pct}%)",
        "ts":   entry["timestamp"]
    })

def add_system_event(msg, event_type="info"):
    alert_queue.append({
        "type": event_type,
        "msg":  msg,
        "ts":   datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    })

fc = 0

# Core AI function
def analyze(frame):
    global fc, live_ai_score, last_alert_text, last_alert_conf
    global last_evidence_ts, last_detection_ts

    fc  += 1
    out  = frame.copy()

    if yolo_model is not None and fc % 3 == 0 and exam_running:
        try:
            results    = yolo_model(frame, verbose=False, conf=CONF_THRESHOLD)[0]
            detections = {}

            if results.obb is not None and len(results.obb) > 0:
                for det in results.obb:
                    cls_id     = int(det.cls[0])
                    conf       = float(det.conf[0])
                    class_name = yolo_model.names.get(cls_id, "unknown")

                    if class_name not in WATCHED_CLASSES:
                        continue
                    if conf < CONF_THRESHOLD:
                        continue

                    pts = det.xyxyxyxy[0].cpu().numpy().astype(int)
                    col = CLASS_COLOUR.get(class_name, (255, 255, 0))

                    if (class_name not in detections or conf > detections[class_name][0]):
                        detections[class_name] = (conf, pts, col)

            for class_name, (conf, pts, col) in detections.items():
                cv2.polylines(out, [pts], isClosed=True, color=col, thickness=2)

            triggered_class = None
            triggered_conf  = 0.0

            for cls in PRIORITY:
                if cls in detections:
                    triggered_class = cls
                    triggered_conf, _, _ = detections[cls]
                    break

            if triggered_class:
                current_time = time.time()
                last_detection_ts = current_time 
                
                conf_pct        = round(triggered_conf * 100)
                live_ai_score   = float(conf_pct)
                last_alert_text = triggered_class.upper()
                last_alert_conf = conf_pct

                if current_time - last_evidence_ts > 5.0:
                    _, pts, col = detections[triggered_class]
                    rx1  = max(0, int(pts[:, 0].min()) - 20)
                    ry1  = max(0, int(pts[:, 1].min()) - 20)
                    rx2  = min(frame.shape[1], int(pts[:, 0].max()) + 20)
                    ry2  = min(frame.shape[0], int(pts[:, 1].max()) + 20)
                    crop = frame[ry1:ry2, rx1:rx2].copy()
                    if crop.size > 0:
                        cv2.rectangle(crop, (0, 0), (crop.shape[1]-1, crop.shape[0]-1), col, 3)
                        cv2.putText(crop, triggered_class.upper(), (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
                        save_evidence(crop, triggered_class, triggered_conf)
                        last_evidence_ts = current_time 
            else:
                live_ai_score = max(0.0, live_ai_score - 1.5)
                if time.time() - last_detection_ts > 2.0:
                    last_alert_text = ""
                    last_alert_conf = 0

        except Exception as e:
            print(f"[YOLO] Error: {e}")

    if not exam_running:
        live_ai_score   = 0.0
        last_alert_text = ""
        last_alert_conf = 0

    if last_alert_text and exam_running:
        col     = CLASS_COLOUR.get(last_alert_text.title(), (0, 0, 255))
        bar_h   = 62
        overlay = out.copy()
        cv2.rectangle(overlay, (0, out.shape[0] - bar_h), (out.shape[1], out.shape[0]), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.65, out, 0.35, 0, out)
        cv2.putText(out, "ALERT:", (12, out.shape[0] - bar_h + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 230), 2)
        cv2.putText(out, last_alert_text, (82, out.shape[0] - bar_h + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.62, col, 2)
        cv2.putText(out, f"Confidence: {last_alert_conf}%", (12, out.shape[0] - bar_h + 48), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (200, 200, 200), 1)

    ts = datetime.now().strftime("%Y-%m-%d  %H:%M:%S")
    cv2.rectangle(out, (0, 0), (out.shape[1], 30), (0, 0, 0), -1)
    cv2.putText(out, f"ExamGuard AI  |  {ts}", (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 220, 160), 1)
    status = "EXAM RUNNING" if exam_running else "STANDBY"
    col2   = (0, 210, 0) if exam_running else (0, 140, 230)
    cv2.putText(out, status, (out.shape[1] - 145, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col2, 2)
    return out

# Camera handling: Connections and background thread
def make_blank_frame(msg="", submsg=""):
    blank = np.zeros((480, 640, 3), dtype=np.uint8)
    if msg: cv2.putText(blank, msg, (30, 225), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (80, 80, 80), 2)
    if submsg: cv2.putText(blank, submsg, (30, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (55, 55, 55), 1)
    _, buf = cv2.imencode(".jpg", blank)
    return buf.tobytes()

def open_camera(source):
    print(f"[CAM] Connecting to: {source}")
    if isinstance(source, str) and (source.startswith("http") or source.startswith("rtsp")):
        c = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    else:
        c = cv2.VideoCapture(source)

    timeout = 15 if isinstance(source, str) else 3
    start   = time.time()
    while not c.isOpened() and (time.time() - start) < timeout:
        time.sleep(0.3)

    if not c.isOpened():
        print(f"[CAM] Failed: {source}")
        c.release()
        return None

    c.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
    c.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    c.set(cv2.CAP_PROP_FPS,          15)
    if isinstance(source, str):
        c.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    print(f"[CAM] Connected: {source}")
    return c

cap          = None
cam_running  = True
switch_event = threading.Event()

def cam_loop():
    global cap, frame_store, camera_source, session_ended
    consecutive_fails = 0
    MAX_FAILS         = 30

    while cam_running:
        if switch_event.is_set():
            switch_event.clear()
            if cap:
                cap.release()
                cap = None
            consecutive_fails = 0

        if session_ended:
            with frame_lock: frame_store = make_blank_frame("Session Ended", "Press Start Session to begin a new session")
            time.sleep(0.5)
            continue

        if cap is None or not cap.isOpened():
            with frame_lock: frame_store = make_blank_frame("Connecting...", str(camera_source))
            new_cap = open_camera(camera_source)
            if new_cap is None:
                with frame_lock: frame_store = make_blank_frame("Cannot connect", str(camera_source))
                for _ in range(20):
                    time.sleep(0.5)
                    if switch_event.is_set(): break
                continue
            cap = new_cap
            consecutive_fails = 0

        ret, frame = cap.read()
        if not ret:
            consecutive_fails += 1
            if consecutive_fails >= MAX_FAILS:
                cap.release()
                cap = None
                consecutive_fails = 0
                with frame_lock: frame_store = make_blank_frame("Reconnecting...")
            time.sleep(0.1)
            continue

        consecutive_fails = 0
        try: processed = analyze(frame)
        except Exception as e:
            print(f"[CAM] Analyze error: {e}")
            processed = frame

        try:
            _, buf = cv2.imencode(".jpg", processed, [cv2.IMWRITE_JPEG_QUALITY, 75])
            with frame_lock: frame_store = buf.tobytes()
        except Exception as e:
            print(f"[CAM] Encode error: {e}")

        time.sleep(0.04)

threading.Thread(target=cam_loop, daemon=True).start()

def cam_watchdog():
    while cam_running:
        time.sleep(5)
        with frame_lock: has_frame = frame_store is not None
        if not has_frame and not session_ended:
            print("[WATCHDOG] No frame — signalling restart")
            switch_event.set()

threading.Thread(target=cam_watchdog, daemon=True).start()

def gen_frames():
    last_sent = None
    while True:
        with frame_lock: data = frame_store
        if data and data is not last_sent:
            last_sent = data
            yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
        else:
            if not data:
                blank = make_blank_frame("Initialising...")
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + blank + b"\r\n")
        time.sleep(0.04)

# Web API Routes for the frontend dashboard
@app.route("/")
def index():
    return render_template("dashboard.html")

@app.route("/evidence_page")
def evidence_page():
    return render_template("evidence.html")

@app.route("/video_feed")
def video_feed():
    return Response(gen_frames(), mimetype="multipart/x-mixed-replace; boundary=frame")

@app.route("/evidence_files/<filename>")
def evidence_file(filename):
    return send_from_directory(EVIDENCE_DIR, filename)

@app.route("/api/upload_students", methods=["POST"])
def upload_students():
    global students, students_loaded
    if "file" not in request.files:
        return jsonify({"success": False, "message": "No file uploaded"}), 400
    
    f = request.files["file"]
    if not f.filename.endswith((".xlsx", ".xls")):
        return jsonify({"success": False, "message": "Only .xlsx or .xls files allowed"}), 400

    filename = secure_filename(f.filename)
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    f.save(filepath)

    loaded = load_students_from_file(filepath)
    if not loaded:
        return jsonify({"success": False, "message": "Could not read file. Check columns: roll, name"}), 400

    students        = loaded
    students_loaded = True
    
    add_system_event(f"Loaded roster with {len(students)} students", "info")
    
    return jsonify({
        "success":  True,
        "message":  f"Loaded {len(students)} students",
        "total":    len(students),
        "students": list(students.values())
    })

@app.route("/api/mark_attendance", methods=["POST"])
def mark_attendance():
    data          = request.get_json()
    present_rolls = set(data.get("present", []))
    for roll, s in students.items():
        s["present"] = roll in present_rolls
    present_count = len(present_rolls)
    absent_count  = len(students) - present_count
    return jsonify({
        "success": True,
        "present": present_count,
        "absent":  absent_count
    })

@app.route("/api/status")
def api_status():
    present = sum(1 for s in students.values() if s["present"])
    return jsonify({
        "exam_running":    exam_running,
        "session_ended":   session_ended,
        "students_loaded": students_loaded,
        "total":           len(students),
        "present":         present,
        "absent":          len(students) - present,
        "alerts_total":    len(evidence_log),
        "ai_score":        live_ai_score
    })

@app.route("/api/students")
def api_students():
    return jsonify(list(students.values()))

@app.route("/api/alerts")
def api_alerts():
    global alert_queue
    out = alert_queue[:]
    alert_queue.clear()
    return jsonify(out)

@app.route("/api/evidence")
def api_evidence():
    return jsonify(evidence_log[::-1])

@app.route("/api/toggle_exam", methods=["POST"])
def toggle_exam():
    global exam_running, session_ended, students
    global students_loaded, evidence_log, alert_queue
    global live_ai_score, last_alert_text, last_alert_conf

    if not exam_running and not students_loaded:
        return jsonify({"success": False, "message": "upload_required"}), 400

    if not exam_running:
        exam_running    = True
        session_ended   = False
        live_ai_score   = 0.0
        last_alert_text = ""
        last_alert_conf = 0
        msg = "Exam session started"
        
        add_system_event(msg, "success")
        return jsonify({"success": True, "exam_running": True, "message": msg})
    else:
        exam_running    = False
        session_ended   = True
        live_ai_score   = 0.0
        last_alert_text = ""
        last_alert_conf = 0
        msg = "Exam session ended"
        students        = {}
        students_loaded = False
        
        add_system_event(msg, "info")
        return jsonify({"success": True, "exam_running": False, "session_ended": True, "message": msg})

@app.route("/api/set_camera", methods=["POST"])
def set_camera():
    global camera_source
    data = request.get_json()
    src  = data.get("source", "").strip()
    if not src:
        return jsonify({"message": "No source provided"}), 400

    if src.isdigit():
        camera_source = int(src)
    elif src.startswith("rtsp://"):
        camera_source = src
    elif src.startswith("http://") or src.startswith("https://"):
        parsed = urlparse(src)
        if parsed.path in ("", "/"):
            camera_source = src.rstrip("/") + "/video"
        else:
            camera_source = src
    else:
        camera_source = "http://" + src + "/video"

    switch_event.set()
    
    add_system_event(f"Camera source set to: {src}", "info")
    return jsonify({"message": f"Connecting to: {camera_source}"})

@app.route("/api/reset", methods=["POST"])
def reset():
    global evidence_log, alert_queue, exam_running, session_ended
    global students, students_loaded, live_ai_score
    global last_alert_text, last_alert_conf

    students        = {}
    students_loaded = False
    exam_running    = False
    session_ended   = False
    live_ai_score   = 0.0
    last_alert_text = ""
    last_alert_conf = 0
    evidence_log.clear()
    alert_queue.clear()
    
    add_system_event("System reset completely", "warning")
    return jsonify({"message": "System reset successfully"})

if __name__ == "__main__":
    print("\n  Open http://127.0.0.1:5000\n")
    app.run(debug=False, threaded=True, host="0.0.0.0", port=5000, use_reloader=False)