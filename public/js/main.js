const form = document.querySelector('form');


form.addEventListener('submit', function (event) {


    let isValid = true;


    const usernameInput = document.querySelector('input[name="username"]');
    const passwordInput = document.querySelector('input[name="password"]');


    const usernameError = usernameInput.nextElementSibling;
    const passwordError = passwordInput.nextElementSibling;


    // איפוס הודעות שגיאה
    usernameError.textContent = '';
    passwordError.textContent = '';


    // בדיקת שם משתמש
    if (usernameInput.value === '') {
        usernameError.textContent = 'יש להזין שם משתמש';
        isValid = false;
    }


    // בדיקת סיסמה
    if (passwordInput.value === '') {
        passwordError.textContent = 'יש להזין סיסמה';
        isValid = false;
    } else if (passwordInput.value.length < 4) {
        passwordError.textContent = 'הסיסמה חייבת להכיל לפחות 4 תווים';
        isValid = false;
    }


    // ביטול שליחת הטופס אם יש שגיאה
    if (!isValid) {
        event.preventDefault();
    }
});
