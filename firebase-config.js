// 這組 config 是「公開」金鑰，本來就會被放在前端程式碼裡，
// 真正的存取限制是靠 Firestore 的安全規則（同步碼長度），不是這組 key。
export const firebaseConfig = {
  apiKey: "AIzaSyC-5Mj29blPSMRVx12iH3rpbp_qx2_LV_A",
  authDomain: "creditcardrewards-cc80d.firebaseapp.com",
  projectId: "creditcardrewards-cc80d",
  storageBucket: "creditcardrewards-cc80d.firebasestorage.app",
  messagingSenderId: "398906768813",
  appId: "1:398906768813:web:a007941e4373bfc957b524",
};
