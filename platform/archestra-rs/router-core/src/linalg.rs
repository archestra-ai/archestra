/// A pivot below this fraction of its original diagonal means the matrix is numerically singular.
const PIVOT_RELATIVE_TOLERANCE: f64 = 1e-12;

/// Solves `m · x = rhs` for a symmetric positive-definite row-major `n×n` matrix by Cholesky.
/// `None` when `m` is not (numerically) positive definite.
pub(crate) fn solve_spd(mut m: Vec<f64>, rhs: &[f64]) -> Option<Vec<f64>> {
    let n = rhs.len();
    if m.len() != n * n {
        return None;
    }
    let diagonal: Vec<f64> = (0..n).map(|i| m[i * n + i]).collect();
    for j in 0..n {
        for i in j..n {
            let s = m[i * n + j] - (0..j).map(|k| m[i * n + k] * m[j * n + k]).sum::<f64>();
            match i == j {
                true if s > PIVOT_RELATIVE_TOLERANCE * diagonal[j] && s.is_finite() => {
                    m[j * n + j] = s.sqrt()
                }
                true => return None,
                false => m[i * n + j] = s / m[j * n + j],
            }
        }
    }
    let mut y = vec![0.0; n];
    for i in 0..n {
        y[i] = (rhs[i] - (0..i).map(|k| m[i * n + k] * y[k]).sum::<f64>()) / m[i * n + i];
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        x[i] = (y[i] - (i + 1..n).map(|k| m[k * n + i] * x[k]).sum::<f64>()) / m[i * n + i];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_spd_and_rejects_singular() {
        let x = solve_spd(vec![4.0, 2.0, 2.0, 3.0], &[2.0, 1.0]).unwrap();
        assert!((x[0] - 0.5).abs() < 1e-15 && x[1].abs() < 1e-15);
        assert_eq!(solve_spd(vec![1.0, 1.0, 1.0, 1.0], &[1.0, 1.0]), None);
    }
}
