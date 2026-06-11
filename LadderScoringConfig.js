const PLAYERS = {
  men: [
    "Afiq","Aiman Basri","Aizat Amir","Akram Amri","Atok Zol","Ayie",
    "Azhar y","Aziedy","Azwan","FAIZ.X","Faizam Hilmy","Fariz Pandi",
    "Firdaus Yaacob","Hafizal Mohd","Ikhlash","Isnu","Khairil Amri",
    "M KAY","M.Syah.Z","Mirulz","Mohammedjunaid","Muzakhkir Amat Nooh",
    "Petchmono","R.Afiq","Raidi Roslee","Rizzu Sahar","Shahir",
    "Thabrani","Wandy","YEN R","ZoulMiey","Ezuardi (Wady)"
  ],
  women: [
    "Aishah Azman","Alia Ramli","Amirah Najla","ANIES Mf","Areen","Asykin",
    "Azikin Nurul","Fae","Fra","Hasliza","Hikmah Madhuri","Iky","ilaaa",
    "Iryani Baharom","jay","Marl","nurulathiah","Sarina lim","Sangeethaa",
    "SCM","Shanira Hanis","ShekynUsesoft","Shikin Salim","Siti Fairuz Yuz",
    "Suhai","Suhaizah","SYU MANAN","WANAWD","Wanie Harman","zaleha",
    "jannah","chu are"
  ]
};

const COURTS      = [1, 3, 5, 7];
const COURT_BONUS = { 1: 4, 3: 3, 5: 2, 7: 1 };
const WIN_PTS     = 10;
const MAX_GAMES   = 8;
const SEASON      = 5;
const TOTAL_WEEKS = 4;

module.exports = { PLAYERS, COURTS, COURT_BONUS, WIN_PTS, MAX_GAMES, SEASON, TOTAL_WEEKS };
