use nalgebra::{DMatrix, DVector};

/// A column whose part independent of the columns before it has norm at most this fraction of
/// the largest such norm counts as dependent. Far above f64 round-off, so a near-duplicate
/// regressor is dropped instead of fit as a huge offsetting pair.
const RANK_TOLERANCE: f64 = 1e-5;

/// Least squares `min ‖a · x − b‖` by Householder QR. Column order is priority: column `j` is
/// dropped (coefficient 0) when `|R_jj|`, its distance from the span of columns `0..j`, is at
/// most [`RANK_TOLERANCE`] times the largest `|R_jj|`. `None` when nothing is kept or the
/// result is not finite.
pub(crate) fn least_squares(a: DMatrix<f64>, b: DVector<f64>) -> Option<DVector<f64>> {
    let width = a.ncols();
    let qr = a.clone().qr();
    let r = qr.r();
    let diagonal: Vec<f64> = (0..r.nrows()).map(|j| r[(j, j)].abs()).collect();
    let scale = diagonal.iter().fold(0.0_f64, |m, &d| m.max(d));
    let kept: Vec<usize> = (0..diagonal.len())
        .filter(|&j| diagonal[j] > RANK_TOLERANCE * scale)
        .collect();
    if kept.is_empty() {
        return None;
    }
    let qr = match kept.len() == width {
        true => qr,
        false => a.select_columns(&kept).qr(),
    };
    let mut qtb = b;
    qr.q_tr_mul(&mut qtb);
    let kept_coefficients = qr.r().solve_upper_triangular(&qtb.rows(0, kept.len()))?;
    let mut x = DVector::zeros(width);
    for (&j, &v) in kept.iter().zip(kept_coefficients.iter()) {
        x[j] = v;
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_full_rank_and_zeroes_dependent_columns() {
        let a = DMatrix::from_row_slice(3, 2, &[1.0, 0.0, 1.0, 1.0, 1.0, 2.0]);
        let x = least_squares(a, DVector::from_row_slice(&[1.0, 3.0, 5.0])).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-14 && (x[1] - 2.0).abs() < 1e-14);

        let a = DMatrix::from_row_slice(2, 2, &[1.0, 2.0, 1.0, 2.0]);
        let x = least_squares(a, DVector::from_row_slice(&[1.0, 3.0])).unwrap();
        assert!((x[0] - 2.0).abs() < 1e-14 && x[1] == 0.0);

        assert_eq!(least_squares(DMatrix::zeros(2, 2), DVector::zeros(2)), None);
        assert_eq!(least_squares(DMatrix::zeros(0, 2), DVector::zeros(0)), None);
    }
}
