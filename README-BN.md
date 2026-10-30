# StudyOS PWA — সেটআপ

এটি একটি client-side PWA project। কোনো backend, database server, framework বা API key লাগে না। HTML, CSS ও Vanilla JavaScript ব্যবহার করা হয়েছে; মূল data browser-এর IndexedDB-তে থাকে।

## ফাইল

- `index.html` — app layout
- `style.css` — responsive UI ও theme
- `app.js` — routine, timer, study records, notes, backup ও analytics
- `manifest.webmanifest` — PWA metadata
- `sw.js` — offline app-shell cache ও notification click handling
- `assets/icons/` — PWA icons

## চালু করার নিয়ম

1. পুরো `StudyOS-PWA` folder-এর ভেতরের সব file ও `assets` folder একই structure-এ রাখুন।
2. GitHub repository-এর root-এ upload করুন। `index.html` অবশ্যই root-এ থাকতে হবে।
3. GitHub Pages বা অন্য HTTPS static hosting চালু করুন।
4. তৈরি হওয়া HTTPS website URL Chrome-এ খুলে পরীক্ষা করুন।
5. PWA Builder-এ website URL দিন; manifest ও service worker সেখান থেকে detect করতে পারবে।

`file://` দিয়ে সরাসরি `index.html` খুললে Service Worker ও PWA install কাজ করবে না। HTTPS hosting প্রয়োজন।

## সময় যোগ হওয়ার নিয়ম

একই তারিখ + একই Subject + একই Chapter দিয়ে একটি daily record তৈরি হয়। প্রতিটি Timer completion বা manual duration addition আলাদা `sessions` entry তৈরি করে। সেই entry-র seconds মূল record-এর `actualSeconds`-এ যোগ হয়। ফলে ৩০ মিনিট + ৪৫ মিনিট + ২৫ মিনিট = ১০০ মিনিট হয়; পুরোনো session overwrite হয় না। Routine-এর planned duration-ও একই daily record-এ যোগ হয়, তবে planned ও actual time আলাদা রাখা হয়।

## Data ও backup

- Subjects, chapters, routines, daily records, sessions, notes ও attachments IndexedDB-তে থাকে।
- Theme ও notification preference LocalStorage-এ থাকে।
- Settings থেকে JSON backup/restore এবং CSV history export করা যায়।
- Browser storage clear করলে local data হারাতে পারে; নিয়মিত JSON backup রাখুন।

## Notifications সম্পর্কে

নোটিফিকেশন পেতে browser permission দিতে হবে। App খোলা থাকা অবস্থায় scheduled reminder check হয়। Android/browser ভেদে app সম্পূর্ণ বন্ধ থাকলে exact-time notification নিশ্চিত নয়।

## সীমাবদ্ধতা

- Audio recording-এর জন্য HTTPS এবং microphone permission প্রয়োজন।
- ছবি/PDF/audio attachment browser-এর IndexedDB quota ব্যবহার করে।
- সব data এই browser/device-এর local storage-এ থাকে; আলাদা device-এ নিতে JSON backup/restore ব্যবহার করুন।
