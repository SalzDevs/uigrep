import './styles.css';

document.querySelectorAll<HTMLButtonElement>('.card button').forEach((button) => {
  button.addEventListener('click', () => {
    const plan = button.closest<HTMLElement>('[data-plan]')?.dataset.plan ?? 'unknown';
    button.textContent = `Selected ${plan}`;
  });
});
