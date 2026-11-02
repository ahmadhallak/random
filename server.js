/**
 * خادم راندوم شات (Random Video Chat Server)
 * يعتمد على Node.js + Express + Socket.io لتوفير:
 * 1. طابور انتظار ذكي ومطابقة عشوائية أو حسب الاهتمامات المشتركة
 * 2. تبادل إشارات WebRTC (Offer, Answer, ICE Candidates)
 * 3. محادثة نصية فورية، مؤشر الكتابة، وردود الفعل التفاعلية
 * 4. نظام إبلاغ وحظر للمستخدمين المخالفين
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// هياكل البيانات لإدارة المتصلين وطابور الانتظار
const waitingQueue = []; // [{ socketId, interests, matchOnlyInterests, region, joinedAt }]
const activePairs = new Map(); // socketId -> partnerSocketId
const userMeta = new Map(); // socketId -> { country, interests, reportsCount }
const blockedPairs = new Set(); // "socketA:socketB" لمنع إعادة المطابقة بعد التخطي أو الإبلاغ

// دالة مساعدة لبث عدد المتصلين الحاليين
function broadcastOnlineCount() {
  io.emit('online_count', {
    count: io.engine.clientsCount
  });
}

// دالة للبحث عن شريك مناسب في طابور الانتظار
function findMatchForUser(socket, prefs) {
  const myId = socket.id;
  const myInterests = Array.isArray(prefs.interests)
    ? prefs.interests.map(i => String(i).trim().toLowerCase()).filter(Boolean)
    : [];
  const matchOnly = Boolean(prefs.matchOnlyInterests);

  // إزالة المستخدم من الطابور إذا كان موجوداً مسبقاً
  removeFromQueue(myId);

  let bestCandidateIndex = -1;
  let bestSharedTags = [];

  for (let i = 0; i < waitingQueue.length; i++) {
    const candidate = waitingQueue[i];
    if (candidate.socketId === myId) continue;

    // التحقق من عدم وجود حظر متبادل
    const pairKey1 = `${myId}:${candidate.socketId}`;
    const pairKey2 = `${candidate.socketId}:${myId}`;
    if (blockedPairs.has(pairKey1) || blockedPairs.has(pairKey2)) continue;

    // حساب الاهتمامات المشتركة
    const shared = myInterests.filter(tag => candidate.interests.includes(tag));

    if (shared.length > 0) {
      bestCandidateIndex = i;
      bestSharedTags = shared;
      break; // أولوية قصوى لمن يشاركه الاهتمامات
    }

    // إذا لم يشترط الطرفان تطابق الاهتمامات، نحتفظ بأول مرشح متاح كخيار بديل
    if (!matchOnly && !candidate.matchOnlyInterests && bestCandidateIndex === -1) {
      bestCandidateIndex = i;
    }
  }

  if (bestCandidateIndex !== -1) {
    const partner = waitingQueue.splice(bestCandidateIndex, 1)[0];
    const partnerSocket = io.sockets.sockets.get(partner.socketId);

    if (!partnerSocket) {
      // في حال انقطع اتصال المرشح للتو، نعيد المحاولة
      return findMatchForUser(socket, prefs);
    }

    // تسجيل الزوج النشط
    activePairs.set(myId, partner.socketId);
    activePairs.set(partner.socketId, myId);

    const roomId = `room_${myId}_${partner.socketId}`;

    // تحديد من يبدأ إرسال WebRTC Offer (الطرف المبادر)
    socket.emit('match_found', {
      roomId,
      partnerId: partner.socketId,
      initiator: true,
      sharedInterests: bestSharedTags,
      partnerCountry: partner.region || '🌍 عالمي'
    });

    partnerSocket.emit('match_found', {
      roomId,
      partnerId: myId,
      initiator: false,
      sharedInterests: bestSharedTags,
      partnerCountry: prefs.region || '🌍 عالمي'
    });

    return true;
  }

  // لم يتم العثور على شريك حالياً -> إضافة المستخدم لطابور الانتظار
  waitingQueue.push({
    socketId: myId,
    interests: myInterests,
    matchOnlyInterests: matchOnly,
    region: prefs.region || '🌍 عالمي',
    joinedAt: Date.now()
  });

  socket.emit('waiting_for_partner');
  return false;
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.findIndex(item => item.socketId === socketId);
  if (idx !== -1) {
    waitingQueue.splice(idx, 1);
  }
}

function disconnectPartner(socketId, reason = 'partner_left') {
  removeFromQueue(socketId);
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    activePairs.delete(socketId);
    activePairs.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('partner_disconnected', { reason });
    }
  }
}

io.on('connection', (socket) => {
  userMeta.set(socket.id, {
    connectedAt: Date.now(),
    reportsCount: 0
  });

  broadcastOnlineCount();

  // 1. بدء البحث عن شريك
  socket.on('find_partner', (prefs = {}) => {
    disconnectPartner(socket.id, 'switched_partner');
    findMatchForUser(socket, prefs);
  });

  // 2. إلغاء البحث
  socket.on('cancel_search', () => {
    removeFromQueue(socket.id);
    socket.emit('search_cancelled');
  });

  // 3. إيقاف المحادثة الحالية أو الانتقال للتالي
  socket.on('leave_chat', () => {
    disconnectPartner(socket.id, 'partner_left');
  });

  // 4. تبادل إشارات WebRTC (SDP Offer / Answer / ICE Candidates)
  socket.on('webrtc_offer', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_offer', {
        sdp: data.sdp,
        from: socket.id
      });
    }
  });

  socket.on('webrtc_answer', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_answer', {
        sdp: data.sdp,
        from: socket.id
      });
    }
  });

  socket.on('webrtc_ice_candidate', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('webrtc_ice_candidate', {
        candidate: data.candidate,
        from: socket.id
      });
    }
  });

  // 5. الرسائل النصية الفورية ومؤشر الكتابة
  socket.on('chat_message', (payload) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId && payload && typeof payload.text === 'string') {
      const cleanText = payload.text.trim().slice(0, 1000);
      if (cleanText) {
        io.to(partnerId).emit('chat_message', {
          text: cleanText,
          timestamp: Date.now()
        });
      }
    }
  });

  socket.on('typing', (isTyping) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('typing', Boolean(isTyping));
    }
  });

  // 6. ردود الفعل العائمة (Reactions)
  socket.on('reaction', (payload) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId && payload && payload.emoji) {
      io.to(partnerId).emit('reaction', {
        emoji: String(payload.emoji).slice(0, 8)
      });
    }
  });

  // 7. الإبلاغ عن شريك مخالف
  socket.on('report_partner', (payload = {}) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      blockedPairs.add(`${socket.id}:${partnerId}`);
      const partnerInfo = userMeta.get(partnerId);
      if (partnerInfo) {
        partnerInfo.reportsCount = (partnerInfo.reportsCount || 0) + 1;
      }
      console.log(`[REPORT] User ${socket.id} reported ${partnerId} for reason: ${payload.reason || 'unspecified'}`);
      disconnectPartner(socket.id, 'reported');
    }
  });

  // 8. معالجة قطع الاتصال النهائي
  socket.on('disconnect', () => {
    disconnectPartner(socket.id, 'disconnected');
    userMeta.delete(socket.id);
    broadcastOnlineCount();
  });
});

// نقطة فحص حالة الخادم (Health Check)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    onlineUsers: io.engine.clientsCount,
    waitingInQueue: waitingQueue.length,
    activeCalls: activePairs.size / 2
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 خادم راندوم شات يعمل الآن على المنفذ: http://localhost:${PORT}`);
  console.log(`📡 WebRTC & Socket.io Signaling Server Ready`);
  console.log(`====================================================`);
});
